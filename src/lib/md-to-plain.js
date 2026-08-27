// Markdown → QQ 纯文本（自研实现）。
// QQ 不渲染 Markdown，agent 的回复在发送前统一转成纯文本：
// 代码块保留内容去围栏、行内代码去反引号、链接保留「文字 (url)」、
// 去除强调/标题/引用/列表标记、表格简化为行文本、折叠多余空行。
export function mdToPlain(md) {
  let s = String(md ?? '');
  // 代码块：去掉围栏行（```lang 与收尾 ```），内容尾部多余空白裁掉
  s = s.replace(/```[^\n]*\n?([\s\S]*?)(?:\n+```|```)/g, (_, body) => body.replace(/\s+$/, ''));
  // 行内代码：去反引号
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片：只剩 alt 文字或 URL（QQ 无法内嵌渲染）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => alt || url);
  // 链接：文字 (url)，保留可点击性
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 强调：粗体/斜体/删除线/下划线标记剥掉
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 块级前缀：标题、引用
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^>\s?/gm, '');
  // 列表：无序项统一成圆点，有序项保留序号
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  s = s.replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + ' ');
  // 表格：去掉分隔行（纯 |:-| 组成），再剥掉行首尾的管道符
  s = s.split('\n')
    .filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, '')))
    .join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 按 QQ 单条消息长度上限切分文本（群消息一般 ≤ 4500 字，留余量）。
 * 切点优先落在换行处；落在代理对中间时回退一个码元，避免 emoji 变乱码。
 */
export function splitForQQ(text, max = 4000) {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 4000;
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    let keep = 0;
    if (cut <= 0) {
      cut = limit; // 没有可用的换行 → 硬切
    } else {
      keep = 1; // 换行符归前段，保持段落结构
    }
    // 切点若落在代理对的高位码元上，回退一位
    if (cut > 0) {
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    // 防御：回退后切点无效（如 max=1 且开头是代理对）时，至少推进一个完整码点
    if (cut + keep <= 0) {
      const first = rest.codePointAt(0);
      cut = first != null && first > 0xffff ? 2 : 1;
      keep = 0;
    }
    out.push(rest.slice(0, cut + keep));
    rest = rest.slice(cut + keep);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
