// chat 模式（回复自动转发回 QQ）用的限制插件：额外禁止发送类工具。
// 通过包内子路径 `qq-mode-console/restrict-chat` 被 0.2 的 preset 引用。
import { makeToolRestrictPlugin } from './tool-restrict.js';

const plugin = makeToolRestrictPlugin({ denySend: true, id: 'qq-tool-restrict-chat' });

export const name = plugin.name;
export const inject = plugin.inject;
export const apply = plugin.apply;
