// 列出 DSH 全部工作区 + 会话，定位用户当前会话
import { NodeApiClient } from '../src/transport/dsh-client.js';

const api = new NodeApiClient('http://127.0.0.1:3080', 30000);

const wr = await api.workspace.list({});
const wv = wr?.result?.ok ? wr.result.value : null;
const sr = await api.sessions.list({});
const sv = sr?.result?.ok ? sr.result.value : null;

console.log('--- 工作区（' + (wv?.items?.length ?? 0) + ' 个）---');
for (const w of wv?.items ?? []) {
  console.log(`  ${w.title} (${w.workspaceId.slice(0, 8)}…) ${w.sessionIds?.length ?? 0} 会话 | ${w.path}`);
}

console.log('\n--- 会话（' + (sv?.items?.length ?? 0) + ' 个，按更新时间倒序前 15）---');
const items = [...(sv?.items ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
for (const s of items.slice(0, 15)) {
  const t = new Date(s.updatedAt * 1000);
  console.log(`  ${s.sessionId.slice(0, 20)}… | running=${s.running} blank=${s.blank} | ${t.toLocaleTimeString()} | cwd=${s.cwd ?? ''}`);
}
process.exit(0);
