// 运行时状态持久化（state/ 目录，不入库）：
// - sessions.json         QQ 会话 → DSH 会话映射（重启后复用）
// - mode.json             运行模式（chat / agent）
// - current-role.json     角色与静默状态（管理员在 QQ/控制台切换）
// - console-token         控制台访问令牌（未配置时自动生成）
// - bridge.lock           单实例锁
// 所有 JSON 写入走「临时文件 + rename」原子写，避免进程中断写坏状态。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJsonSafe } from './lib/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const STATE_DIR = path.join(ROOT, 'state');
export const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
export const MODE_FILE = path.join(STATE_DIR, 'mode.json');
export const ROLE_FILE = path.join(STATE_DIR, 'current-role.json');
export const CONSOLE_TOKEN_FILE = path.join(STATE_DIR, 'console-token');
export const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
export const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
export const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

/** 原子写 JSON 文件（临时文件 + rename；目录自动创建；权限 600）。 */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 原子写文本文件。 */
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 会话映射：{ 'group:123': sessionId, 'private:456': sessionId }。 */
export function loadSessions() {
  return readJsonSafe(SESSIONS_FILE, {}) ?? {};
}
export function saveSessions(sessions) {
  atomicWriteJson(SESSIONS_FILE, sessions);
}

/** 运行模式。默认 chat（agent 仿真群友）。 */
export function loadMode() {
  const m = readJsonSafe(MODE_FILE, { mode: 'chat' });
  const mode = String(m?.mode ?? 'chat');
  return ['chat', 'agent'].includes(mode) ? mode : 'chat';
}
export function saveMode(mode) {
  atomicWriteJson(MODE_FILE, { mode });
}

/** 角色/静默状态：{ role: string|null, mode: 'active'|'silent' }。 */
export function readRoleState() {
  const s = readJsonSafe(ROLE_FILE, { role: null, mode: 'active' }) ?? {};
  return {
    role: typeof s.role === 'string' && s.role ? s.role : null,
    mode: s.mode === 'silent' ? 'silent' : 'active',
  };
}
export function writeRoleState(role, mode = 'active') {
  atomicWriteJson(ROLE_FILE, {
    role: typeof role === 'string' && role ? role : null,
    mode: mode === 'silent' ? 'silent' : 'active',
  });
}

/** 控制台令牌：config.json 配了就用配置值；否则读持久化值；都没有则生成强令牌并持久化。 */
export function loadOrCreateConsoleToken(configuredToken = '') {
  const configured = String(configuredToken ?? '').trim();
  if (configured) return configured;
  try {
    const existing = fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(CONSOLE_TOKEN_FILE, token);
  return token;
}

/**
 * 单实例锁（原子 wx 创建 + stale 检测）。
 * @returns true=拿锁成功；false=已有存活实例（main.js 以退出码 2 退出，start.bat 识别）。
 */
export function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', encoding: 'utf8' });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return false;
    }
  };
  if (tryCreate()) return true;
  try {
    const prev = readJsonSafe(LOCK_FILE, null);
    if (Number.isInteger(prev?.pid) && prev.pid !== process.pid) {
      try {
        process.kill(prev.pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') {
          fs.unlinkSync(LOCK_FILE);
          return tryCreate();
        }
      }
    }
  } catch {}
  return false;
}

export function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}
