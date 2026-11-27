// 验证 qq_send_voice 工具描述已是新版（edge-tts + 中日自动切换）。
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
const t = tools.tools.find((x) => x.name === 'qq_send_voice');
console.log(`tools: ${tools.tools.length}`);
console.log(`desc: ${t?.description}`);
console.log(`mentionsHuihui: ${/Huihui/.test(t?.description ?? '')}`);
console.log(`mentionsJa: ${/Nanami/.test(t?.description ?? '')}`);
await client.close();
