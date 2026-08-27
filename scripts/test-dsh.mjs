#!/usr/bin/env node
// DSH 链路自测（不需要 NapCat / QQ）：
// 验证桥接的 DSH 侧链路是否打通 —— 订阅事件流 → 创建工作区+测试会话 → 投递 prompt
// → 收集回合回复。
//
// 用法：
//   npm run self-test                     # 默认 http://127.0.0.1:3080
//   DSH_URL=http://127.0.0.1:3080 npm run self-test
//
// 预期输出：连接成功 → 会话创建 → prompt 被接受 → 打印 agent 回复文本。
// 注意：会话必须挂在 workspace 下，且先订阅 mux 再建会话（与桥接 ensureSession 时序一致），
// 否则 DSH 不向该连接推送 session/event（实测 standalone 会话收不到事件流）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap } from '../src/transport/dsh-client.js';
import { createTurnCollector } from '../src/core/turn-collector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const baseUrl = String(process.env.DSH_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
const api = new NodeApiClient(baseUrl, 180000);

async function main() {
  // 1) 探活
  console.log(`[self-test] 连接 ${baseUrl} …`);
  try {
    await api.sessions.list({});
    console.log('[self-test] ✅ DSH 在线');
  } catch (error) {
    console.error(`[self-test] ❌ DSH 不可达：${error?.message ?? error}`);
    process.exit(1);
  }

  // 2) 先订阅事件流（与桥接 pump 时序一致；signal 必填）
  const abort = new AbortController();
  const killer = setTimeout(() => abort.abort(), 120000);
  const collector = createTurnCollector();
  let sessionId = null;
  let completed = false;

  const streamPromise = (async () => {
    for await (const envelope of api.events.mux({}, abort.signal)) {
      const frame = envelope.payload;
      if (frame.type !== 'session/event' || frame.sessionId !== sessionId) continue;
      const ended = collector.push(frame.event);
      if (ended) {
        completed = true;
        if (ended.reason.kind === 'completed' && ended.text.trim()) {
          console.log(`\n[self-test] ✅ agent 回复（${ended.text.length} 字）：\n${ended.text}`);
        } else {
          console.log(`\n[self-test] ⚠️ 回合结束但无文本：${JSON.stringify(ended.reason)}`);
        }
        abort.abort();
      }
    }
  })();

  // 3) 创建工作区 + 独立测试会话（不带 preset，避免未安装 preset 时报错）
  const dir = path.join(ROOT, 'state', 'self-test');
  fs.mkdirSync(dir, { recursive: true });
  let workspaceId = null;
  try {
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
    workspaceId = wsValue.workspace.workspaceId;
    const value = unwrap(await api.sessions.create({ workspaceId }), 'session.create');
    sessionId = value.sessionId;
    console.log(`[self-test] ✅ 测试会话创建：${sessionId}`);
  } catch (error) {
    console.error(`[self-test] ❌ 会话创建失败：${error?.message ?? error}`);
    abort.abort();
    process.exit(1);
  }

  // 4) 投递 prompt
  console.log('[self-test] 投递 prompt …');
  try {
    const accepted = unwrap(await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '这是一条 NimuQDock-dsh 桥接自测消息。请只回复两个字：pong' }],
    }), 'session.prompt');
    if (accepted?.accepted) console.log('[self-test] ✅ prompt 已接受');
  } catch (error) {
    console.error(`[self-test] ❌ prompt 投递失败：${error?.message ?? error}`);
    abort.abort();
    process.exit(1);
  }

  await streamPromise;
  clearTimeout(killer);

  // 5) 清理：归档会话、删除测试工作区
  if (sessionId) {
    try { await api.workspace.archiveSession({ sessionId }); } catch {}
  }
  if (workspaceId) {
    try { await api.workspace.delete({ workspaceId }); } catch {}
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  if (!completed) {
    console.error('[self-test] ❌ 120s 内未收到回合结束事件');
    process.exit(1);
  }
  console.log('\n[self-test] 链路验证通过。');
  process.exit(0);
}

main().catch((error) => {
  console.error('[self-test] 失败:', error);
  process.exit(1);
});
