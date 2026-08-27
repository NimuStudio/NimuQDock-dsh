// 人格引擎事件判定词表（自研小词表，可扩展）。
// 用于把 QQ 消息事件归类为情绪事件：被怼 / 被夸 / 问句。
// 约束：词条尽量用多字组合，避免单字误伤；词条间避免互相包含（如'不行'⊆'行不行'）
// 导致一条消息同时命中怼/夸。
export const ROAST_WORDS = [
  '废物', '没用', '垃圾', '笨蛋', '傻子', '蠢货', '弱鸡', '菜鸡',
  '差劲', '拉胯', '太烂', '真差', '坑货', '笨死了', '脑子呢', '不行啊',
  '你行吗', '就这', '拉倒吧', '丢人', '废了', '吃白饭', '大肥鱼',
];

export const PRAISE_WORDS = [
  '厉害', '太强', '真棒', '好棒', '聪明', '可爱', '爱了', '喜欢',
  '大神', '大佬', '天才', '优秀', '佩服', '真行', '牛啊', '好牛',
];

export const QUESTION_MARKERS = [
  '？', '?', '吗', '呢', '啥', '什么', '怎么', '为什么', '哪',
  '几', '是不是', '能不能', '可不可以', '行不行', '有没有',
];

/** 文本是否命中词表中任意词。 */
export function containsAny(text, words) {
  const s = String(text ?? '');
  if (!s) return false;
  return words.some((w) => s.includes(w));
}

/**
 * 判定一条消息对机器人的情绪属性。
 * @param {string} text 消息文本
 * @param {boolean} directed 是否直接指向机器人（@/引用/点名）
 * @returns {{ roasted: boolean, praised: boolean, question: boolean }}
 */
export function classifyMood(text, directed) {
  const s = String(text ?? '');
  if (!directed) return { roasted: false, praised: false, question: false };
  return {
    roasted: containsAny(s, ROAST_WORDS),
    praised: containsAny(s, PRAISE_WORDS),
    question: containsAny(s, QUESTION_MARKERS),
  };
}
