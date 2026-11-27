// 用 MCP 客户端起一个真实的 qq-mcp.js，调 qq_memory_search 验证工具层能查到正式库里的消息。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const transport = new StdioClientTransport({
  command: path.join(appRoot, 'node', 'node.exe'),
  args: [path.join(appRoot, 'src', 'mcp', 'qq-mcp.js')],
  cwd: appRoot,
  stderr: 'ignore',
});
const client = new Client({ name: 'probe', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);
const tools = await client.listTools();
console.log(`tools: ${tools.tools.length}, has qq_memory_search: ${tools.tools.some((t) => t.name === 'qq_memory_search')}`);

for (const q of ['测试', '哥布林', '开会']) {
  const res = await client.callTool({ name: 'qq_memory_search', arguments: { query: q, limit: 5 } });
  const text = res.content?.[0]?.text ?? '';
  console.log(`\n--- query=${q} ---\n${text.slice(0, 400)}`);
}
await client.close();
