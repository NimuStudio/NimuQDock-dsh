#!/usr/bin/env node
// 护栏一致性测试：qq-chat 与 qq-agent 的 qq-tool-restrict.mjs 除
// DENY_SEND 常量（chat=true / agent=false）外必须逐字一致，
// 防止两个副本权限面静默漂移（chat 意外放宽或 agent 意外收紧）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat', 'qq-tool-restrict.mjs');
const B = path.join(ROOT, 'dsh', 'agent-presets', 'qq-agent', 'qq-tool-restrict.mjs');

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed += 1;
};

const stripDenySend = (text) => text.replace(/^const DENY_SEND = (?:true|false).*$/m, 'const DENY_SEND = X');

// 比较代码主体：从「const HIDDEN_DEV_TOOLS」开始到文件结尾（头部注释允许描述各自 preset）
const body = (text) => text.slice(text.indexOf('// DSH 0.1.1-rc.2'));

const a = fs.readFileSync(A, 'utf8');
const b = fs.readFileSync(B, 'utf8');

check('两副本代码主体逐字一致（仅 DENY_SEND 常量不同）', body(stripDenySend(a)) === body(stripDenySend(b)));
check('qq-chat DENY_SEND = true', /^const DENY_SEND = true$/m.test(a));
check('qq-agent DENY_SEND = false', /^const DENY_SEND = false$/m.test(b));
check('发送类工具清单一致', a.split('const QQ_SEND_TOOLS')[1].split(']')[0] === b.split('const QQ_SEND_TOOLS')[1].split(']')[0]);
check('guard 白名单前缀一致', a.includes("'mcp__napcat__', 'mcp__web-search-safe__'") && b.includes("'mcp__napcat__', 'mcp__web-search-safe__'"));

console.log(failed === 0 ? '✅ 护栏一致性全部通过' : `❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
