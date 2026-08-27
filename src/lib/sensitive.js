// 敏感信息审计正则（自研实现）。
// 用于拦截/脱敏 agent 回复、MCP 发送、提问/审批文本中的两类泄露特征：
//  1) 本机路径：Windows 盘符路径（C:\... 或 C:/...）、UNC 网络共享（\\server\share）、
//     Unix 家目录/系统目录（/home/ /Users/ /etc/ /var/）
//  2) 凭据泄露：凭据关键词 + 赋值关系或紧邻值。
//     关键词必须带赋值（: = ： 是 为）或跟随令牌样式值才判定，避免误伤日常聊天
//     （比如正常说"token"一词本身不算泄露）。
export const SENSITIVE_RE = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/][^\s"'<>|]{1,}|\\\\(?!\s)[^\\\s]{2,}\\[^\s"'<>|]{1,}|(?:\/home\/|\/Users\/|\/etc\/|\/var\/)[^\s"'<>|]{1,}|(?:password|passwd|secret|token|api[_-]?key|authorization|bearer|access[_-]?key|credential|密码|密钥|口令|凭据)(?:\s*(?:[:=：]|是|为)\s*[^\s，。；、]{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;
