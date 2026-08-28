#!/usr/bin/env node
// 测试安全 Web Search / Fetch MCP server：
// 1) isPrivateIp 单元测试：IPv4/IPv6/内嵌 IPv4（IPv4-mapped、NAT64、6to4）绕过案例
// 2) MCP 工具联测：web_search 正常搜索、web_fetch 抓公网、内网/协议/凭据 URL 被拒
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isPrivateIp } from '../src/mcp/web-search-mcp.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}：期望 ${expected}，实际 ${actual}`);
}

console.log('── isPrivateIp 单元测试 ──');
// IPv4 私网/保留段
check('127.0.0.1', isPrivateIp('127.0.0.1'), true);
check('10.1.2.3', isPrivateIp('10.1.2.3'), true);
check('172.16.0.1', isPrivateIp('172.16.0.1'), true);
check('172.31.255.255', isPrivateIp('172.31.255.255'), true);
check('172.32.0.1（公网）', isPrivateIp('172.32.0.1'), false);
check('192.168.1.1', isPrivateIp('192.168.1.1'), true);
check('169.254.169.254（云元数据）', isPrivateIp('169.254.169.254'), true);
check('100.64.0.1（CGNAT）', isPrivateIp('100.64.0.1'), true);
check('0.0.0.0', isPrivateIp('0.0.0.0'), true);
check('224.0.0.1（组播）', isPrivateIp('224.0.0.1'), true);
check('8.8.8.8（公网）', isPrivateIp('8.8.8.8'), false);
// IPv6
check('::1', isPrivateIp('::1'), true);
check('::', isPrivateIp('::'), true);
check('fc00::1（ULA）', isPrivateIp('fc00::1'), true);
check('fe80::1（link-local）', isPrivateIp('fe80::1'), true);
check('2001:db8::1（文档）', isPrivateIp('2001:db8::1'), true);
check('ff02::1（组播）', isPrivateIp('ff02::1'), true);
check('2606:4700::1111（公网）', isPrivateIp('2606:4700::1111'), false);
// 内嵌 IPv4 绕过
check('::ffff:127.0.0.1', isPrivateIp('::ffff:127.0.0.1'), true);
check('::ffff:7f00:1', isPrivateIp('::ffff:7f00:1'), true);
check('::ffff:1（单组短形式→0.0.0.1）', isPrivateIp('::ffff:1'), true);
check('::ffff:0:c0a8:101（→192.168.1.1）', isPrivateIp('::ffff:0:c0a8:101'), true);
check('64:ff9b::c0a8:101（NAT64→192.168.1.1）', isPrivateIp('64:ff9b::c0a8:101'), true);
check('64:ff9b::1（NAT64 单组→0.0.0.1）', isPrivateIp('64:ff9b::1'), true);
check('64:ff9b:1::1（NAT64 48→0.0.0.1）', isPrivateIp('64:ff9b:1::1'), true);
check('2002:c0a8:0101::（6to4→192.168.1.1）', isPrivateIp('2002:c0a8:0101::'), true);

console.log('\n── MCP 工具联测 ──');
const entry = fileURLToPath(new URL('../src/mcp/web-search-mcp.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ Web Search MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  // 正常搜索（依赖外网：网络不可用时警告但不判失败，避免误报；SSRF 拦截断言才是核心）
  const search = await client.callTool({ name: 'web_search', arguments: { query: 'DeepSeek娘 萌娘百科' } });
  const searchText = search.content?.[0]?.text ?? '';
  console.log(`${search.isError ? '⚠️' : '✅'} web_search 返回 ${searchText.length} 字符${search.isError ? '（网络不可用？）' : ''}`);
  if (!search.isError) console.log('   摘要:', searchText.slice(0, 150).replace(/\n/g, ' '));

  // 正常抓取公网页面（同上：网络失败仅警告）
  const fetch = await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'https://www.example.com/' },
  });
  const fetchText = fetch.content?.[0]?.text ?? '';
  console.log(`${fetch.isError ? '⚠️' : '✅'} web_fetch 公网: ${fetchText.slice(0, 120).replace(/\n/g, ' ')}`);

  // 内网/危险 URL 应全部被拒
  const badUrls = [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://192.168.1.1/admin',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[64:ff9b::c0a8:101]/',
    'file:///etc/passwd',
    'http://user:pass@example.com/',
  ];
  for (const url of badUrls) {
    const res = await client.callTool({ name: 'web_fetch', arguments: { url } });
    const blocked = res.isError === true;
    console.log(`${blocked ? '✅' : '❌'} 拦截 ${url} → ${blocked ? `被拒: ${(res.content?.[0]?.text ?? '').slice(0, 60)}` : '⚠️ 未被拒绝！'}`);
    if (!blocked) failed += 1;
  }

  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
