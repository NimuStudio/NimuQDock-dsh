// agent 模式（仿真群友，自己决定要不要发言）用的限制插件：允许发送类工具。
// 通过包内子路径 `qq-mode-console/restrict-agent` 被 0.2 的 preset 引用。
import { makeToolRestrictPlugin } from './tool-restrict.js';

const plugin = makeToolRestrictPlugin({ denySend: false, id: 'qq-tool-restrict-agent' });

export const name = plugin.name;
export const inject = plugin.inject;
export const apply = plugin.apply;
