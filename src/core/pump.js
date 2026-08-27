// DSH 事件流泵（events.mux 消费循环）——M2：agent 回复/提问/审批回 QQ 的闭环。
//
// 协议事实（已对照本地 DSH @deepseek-ai/dsh-session + dsh-host-apiproxy 类型核实）：
// - api.events.mux({}, signal) 返回 AsyncIterable<{ rpcId, payload: MuxFrame }>。
//   payload.type 可能为：session/event、session/subscribed、approval/requested、
//   approval/resolved、question/requested、question/resolved、session/queue、
//   session/jobs、session/projection、stream/error。
// - mux 打开时会重放未决的 approval/question requested 帧（rpcId 原样复用），
//   重连后无需手动恢复挂起项。
// - SessionEvent 关键形状：
//   turn/start {turn}；turn/end {turn, reason: {kind: completed|aborted|blocked|error|max-tokens|interrupted}}
//   assistant/message {turn, step, message:{content: ContentBlock[]}}
//   tool/call {turn, step, callId, name, arguments(原始 JSON 字符串)}
//   tool/result {turn, step, message:{source:{kind:'tool', callId}, content:[{type:'tool-result', isError?}]}, error?}
// - 断线后（迭代器抛出或结束）必须清空瞬时状态再 3s 重试：
//   否则 turn collector 残留会导致回复文本重复累加（实测踩坑）。
import { createTurnCollector } from './turn-collector.js';
import { mdToPlain } from '../lib/md-to-plain.js';
import { SENSITIVE_RE } from '../lib/sensitive.js';
import { appendActivity } from '../log.js';

/** 发送类工具：本回合 AI 调用成功过这些工具 → 跳过自动转发，避免重复发送。 */
const SEND_TOOL_RE = /^mcp__napcat__qq_(send_group_message|send_private_message|reply|send_message|send_burst)$/;
const isSendTool = (name) => SEND_TOOL_RE.test(String(name ?? ''));

export function startPump({ api, cfg, sessions, sender, router, log, signal }) {
  const collectors = new Map();          // sessionId -> turn collector（turn 结束即删）
  const sendToolSucceeded = new Set();   // sessionId：本回合发送工具已成功
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：在途发送类工具调用
  const toolCallNames = new Map();       // sessionId -> Map<callId, toolName>

  const clearTransient = () => {
    collectors.clear();
    sendToolSucceeded.clear();
    pendingSendToolCalls.clear();
    toolCallNames.clear();
  };

  /** 提问/审批文本过敏感审计，命中则替换为占位，防止敏感内容外泄到 QQ。 */
  const safeText = (text, key, label) => {
    const s = String(text ?? '');
    if (SENSITIVE_RE.test(s)) {
      log(`⚠️ ${label}含敏感信息，已隐藏 (${key})`);
      return '（含敏感信息，已隐藏）';
    }
    return s;
  };

  const loop = async () => {
    while (!signal?.aborted) {
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({}, signal)) {
          const frame = envelope.payload;

          if (frame.type === 'session/event') {
            const key = sessions.keyOf(frame.sessionId);
            if (!key) continue; // 非本桥接会话（未来黑话学习会话等在此扩展）
            const event = frame.event;

            // ── 回合级工具追踪：发送类工具成功 → 跳过自动转发 ──
            if (event.type === 'turn/start') {
              sendToolSucceeded.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
            }
            if (event.type === 'tool/call') {
              const toolName = String(event.data?.name ?? '');
              const callId = event.data?.callId;
              if (callId != null && isSendTool(toolName)) {
                let pending = pendingSendToolCalls.get(frame.sessionId);
                if (!pending) {
                  pending = new Set();
                  pendingSendToolCalls.set(frame.sessionId, pending);
                }
                pending.add(String(callId));
              }
              if (callId != null) {
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (event.type === 'tool/result') {
              const callId = event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = event.data?.message?.content?.[0];
              const resultError = event.data?.error != null || resultBlock?.isError === true;
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(String(callId))) {
                  pending.delete(String(callId));
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) sendToolSucceeded.add(frame.sessionId);
                }
              }
            }

            // ── turn 收集：assistant/message 累加，turn/end 产出 ──
            const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
            collectors.set(frame.sessionId, collector);
            const ended = collector.push(event);
            if (!ended) continue;

            collectors.delete(frame.sessionId);
            const sendToolSucceededNow = sendToolSucceeded.has(frame.sessionId);
            sendToolSucceeded.delete(frame.sessionId);
            pendingSendToolCalls.delete(frame.sessionId);
            toolCallNames.delete(frame.sessionId);

            // 本回合已通过 MCP 发送工具成功发出消息：跳过自动转发（避免重复）
            if (sendToolSucceededNow) {
              log(`工具已发送消息，跳过自动转发 (${key})`);
              router.onAgentTurnEnd?.(key, { replied: true });
              continue;
            }

            if (ended.reason.kind === 'completed' && ended.text.trim()) {
              const plain = mdToPlain(ended.text);
              // 纯 Markdown/空白输出按「无文本」处理
              if (!plain.trim()) {
                log(`agent 回复为空（仅格式/空白）(${key})`);
                continue;
              }
              // 敏感审计（与 Sender 内部审计一致；此处区分拦截以便提示）
              const { blocked, reason } = sender.audit(plain);
              if (blocked) {
                log(`⚠️ 回复被安全策略拦截 (${key})：${reason}`);
                appendActivity(`${key} agent 回复被拦截（${reason}）`);
                if (cfg.security?.interceptNotify !== false) {
                  await sender.notify(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                }
                continue;
              }
              log(`agent 回复 (${key}) ${plain.length} 字`);
              appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
              // agent 模式：文本不自动转发（只是思考）
              if (router.getMode() === 'agent') {
                // 私聊兜底：一对一场景没有「潜水」语义——AI 输出纯文本（未调发送工具）视为直接回复
                if (key.startsWith('private:')) {
                  log(`[agent] 私聊纯文本兜底发送 (${key}): ${plain.slice(0, 60)}`);
                  await sender.sendToQQ(key, plain);
                  router.onAgentTurnEnd?.(key, { replied: true });
                  continue;
                }
                log(`[agent] AI 内部输出 (${key}): ${plain.slice(0, 80)}`);
                router.onAgentTurnEnd?.(key, { replied: false });
                continue;
              }
              await sender.sendToQQ(key, plain);
            } else if (ended.reason.kind === 'error') {
              const msg = ended.reason.error?.message ?? '未知错误';
              log(`agent 回合出错 (${key}): ${msg}`);
              await sender.notify(key, `⚠️ agent 处理出错：${String(msg).slice(0, 500)}`);
            } else if (ended.reason.kind === 'aborted') {
              await sender.notify(key, '⏹️ 已停止');
            } else {
              // completed 但无文本（纯工具回合）/ max-tokens / blocked / interrupted：仅日志
              log(`回合结束（${ended.reason.kind}）无文本 (${key})`);
              // agent 模式：completed 但无输出视为「无行动」回合，参与防卡死计数
              if (ended.reason.kind === 'completed' && router.getMode() === 'agent') {
                router.onAgentTurnEnd?.(key, { replied: false });
              }
            }
            continue;
          }

          if (frame.type === 'question/requested') {
            const key = sessions.keyOf(frame.sessionId);
            if (!key) continue;
            // mux 断线重连会重放未决帧（rpcId 原样复用）：已挂起过则跳过，避免群里重复通知
            if (router.hasPendingRpc?.(envelope.rpcId)) continue;
            const lines = frame.questions.map((q, i) => {
              const qText = safeText(q.question, key, '提问文本');
              let s = `${i + 1}. ${qText}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => `「${safeText(o.label, key, '提问选项')}」`);
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sender.notify(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复你的回答）');
            router.registerPending(key, {
              kind: 'question',
              rpcId: envelope.rpcId,
              sessionId: frame.sessionId,
              questions: frame.questions,
            });
            continue;
          }

          if (frame.type === 'approval/requested') {
            const key = sessions.keyOf(frame.sessionId);
            if (!key) continue;
            if (router.hasPendingRpc?.(envelope.rpcId)) continue;
            const reason = safeText(frame.reason, key, '审批理由');
            const toolName = safeText(frame.toolName, key, '审批工具名');
            await sender.notify(key, `🔐 agent 请求审批：${toolName}${reason ? `\n理由：${reason}` : ''}\n回复「通过」或「拒绝」`);
            router.registerPending(key, {
              kind: 'approval',
              rpcId: envelope.rpcId,
              sessionId: frame.sessionId,
              approvalId: frame.approvalId,
              toolName: frame.toolName,
            });
            continue;
          }

          if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
            continue;
          }
          // session/subscribed、approval/resolved、question/resolved、
          // session/queue、session/jobs、session/projection：当前版本忽略
        }
      } catch (error) {
        if (signal?.aborted) break;
        log('事件流中断:', error?.message ?? error);
      }
      // 无论异常还是正常结束都清空瞬时状态，防止重连后 turn 残留导致重复累加
      clearTransient();
      await new Promise((r) => setTimeout(r, 3000));
    }
  };

  const running = loop().catch((error) => log('pump 循环退出:', error?.message ?? error));
  return { running, clearTransient };
}
