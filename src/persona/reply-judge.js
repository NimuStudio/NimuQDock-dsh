// 「该不该回」双路判断器：
//   A. 本地小模型（llama.cpp 的 llama-server，OpenAI 兼容接口）
//   B. 规则引擎（engagement.js 的评分）
//
// 设计原则：
//   - 模型可用 → 由模型判断语义（是否在叫它）；上下文相关的信号（@/引用/冷却/连续接话）
//     仍由规则处理，因为 0.6B 级别的模型带上聊天记录会被自己的发言带偏（实测 10/10 → 8/10）；
//   - 模型不可用/超时/输出无法解析 → 自动回退规则，用户无感；
//   - chat 模式完全不经过这里（消息原样交给 DSH）。
//
// 提示词实测（Qwen3-0.6B Q4_K_M，RTX 4060，约 40-80ms/条）：
//   显式规则 + 同格式示例 → 10/10；抽象指令或纯多轮 few-shot → 全部答 YES。

/** 判断器系统提示词（实测最稳的写法：硬规则 + 同格式示例，输出 YES/NO）。 */
export function judgeSystemPrompt(botName) {
  const name = (typeof botName === 'function' ? botName() : botName) || 'dsh';
  return [
    `你是 QQ 群聊机器人「${name}」的接话分类器。`,
    `硬规则：先检查消息里有没有出现 —— 机器人名字 ${name}、@、引用、「你」「你自己」「您」。`,
    '注意：「你们」是对一群人说的，不算在叫它。',
    '如果一个都没有，直接输出 NO，不要考虑其他因素。',
    '如果有，再判断是不是在跟它说话：是的输出 YES，不是（在跟别人说话、在说别的 AI、只是感叹）输出 NO。',
    '',
    '示例：',
    '消息：他说话我居然听懂了 输出：NO',
    '消息：这咋办 有人会吗 输出：NO',
    '消息：今晚吃啥 输出：NO',
    '消息：[图片] 输出：NO',
    '消息：蓝毛 有品味 输出：NO',
    '消息：你们景叔叔全听懂了 输出：NO',
    '消息：你们真有意思 输出：NO',
    '消息：看不出来是你自己吗 输出：YES',
    `消息：@${name} 我喜欢你 输出：YES`,
    `消息：${name} 你觉得呢 输出：YES`,
    '消息：你自己说是不是 输出：YES',
  ].join('\n');
}

export class ReplyJudge {
  /**
   * @param {{ cfg: object, log: Function, botName?: string }} deps
   */
  constructor({ cfg, log = () => {}, botName = '' }) {
    this.cfg = cfg;
    this.log = log;
    this.botName = botName;
    this.lastHealth = 0;
    this.healthy = false;
    this.healthTtlMs = 10000;
  }

  /** 模型判断器是否启用（配置 judge.enabled：auto|on|off，默认 auto）。 */
  get enabled() {
    return String(this.cfg?.judge?.enabled ?? 'auto') !== 'off';
  }

  get baseUrl() {
    return String(this.cfg?.judge?.url ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  }

  get timeoutMs() {
    return Number(this.cfg?.judge?.timeoutMs ?? 2500);
  }

  /** 探测 llama-server 是否可用（带 TTL 缓存，避免每条消息都探）。 */
  async available() {
    if (!this.enabled) return false;
    const now = Date.now();
    if (now - this.lastHealth < this.healthTtlMs) return this.healthy;
    this.lastHealth = now;
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        this.healthy = json?.status === 'ok' || res.ok;
        return this.healthy;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch {
      // 某些版本没有 /health，退回 /v1/models
      try {
        const res = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(1500) });
        this.healthy = res.ok;
      } catch {
        this.healthy = false;
      }
    }
    return this.healthy;
  }

  /**
   * 让模型判断该不该回（只看最新消息；上下文相关的信号交给规则）。
   * @param {string} text 最新消息
   * @returns {Promise<{reply: boolean, source: 'model', raw: string} | null>}
   *          模型不可用/失败时返回 null（调用方回退规则）
   */
  async judge(text) {
    if (!(await this.available())) return null;
    const body = {
      model: this.cfg?.judge?.model ?? 'local',
      messages: [
        { role: 'system', content: judgeSystemPrompt(this.botName) },
        { role: 'user', content: `消息：${String(text ?? '').slice(0, 300)} 输出：` },
      ],
      temperature: 0,
      max_tokens: 4,
      stream: false,
      // 关掉 Qwen3 的思考模式（llama.cpp 支持 chat_template_kwargs）
      chat_template_kwargs: { enable_thinking: false },
    };
    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const message = json?.choices?.[0]?.message ?? {};
      // 万一模型还是进了思考模式，content 可能为空、正文在 reasoning_content 里
      const raw = String(message.content ?? '').trim() || String(message.reasoning_content ?? '').trim();
      const match = raw.match(/\b(yes|no)\b/i);
      if (!match) return null;
      return { reply: match[1].toLowerCase() === 'yes', source: 'model', raw };
    } catch (error) {
      this.log(`[judge] 模型判断失败，回退规则：${error?.message ?? error}`);
      return null;
    }
  }
}
