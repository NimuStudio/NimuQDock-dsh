// 验证 isDirectedAtAi 的 @ 指向识别（关键场景）
import { Router } from '../src/core/router.js';

// 最小化依赖构造
const router = new Router({
  api: {},
  bot: { nickname: 'dsh', selfId: '3533396073' },
  cfg: { social: {} },
  sessions: { state: { sessions: {} } },
  sender: {},
  log: () => {},
  persona: null,
});

const groupMsg = (segments, text) => ({
  kind: 'group',
  convId: '757385335',
  userId: '12345',
  selfId: '3533396073',
  messageId: -1,
  seq: 1,
  time: Math.floor(Date.now() / 1000),
  segments,
  senderName: '小明',
});

const cases = [
  // [描述, 消息, 期望]
  ['@机器人（at段）→ 被点名', groupMsg([{ type: 'at', data: { qq: '3533396073' } }, { type: 'text', data: { text: '在吗' } }], '@小dsh 在吗'), true],
  ['@别人+提到别名 → 不被点名（关键修复）', groupMsg([{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: '小鲸鱼是啥鱼' } }], '@小明 小鲸鱼是啥鱼'), false],
  ['文本@dsh昵称 → 被点名', groupMsg([{ type: 'text', data: { text: '@dsh 在吗' } }], '@dsh 在吗'), true],
  ['文本提到别名无@ → 不被点名', groupMsg([{ type: 'text', data: { text: '小鲸鱼 好可爱' } }], '小鲸鱼 好可爱'), false],
  ['文本@别人 → 不被点名', groupMsg([{ type: 'text', data: { text: '@小明 吃饭了吗' } }], '@小明 吃饭了吗'), false],
  ['@dshh（昵称前缀）→ 不误判', groupMsg([{ type: 'text', data: { text: '@dshh 你好' } }], '@dshh 你好'), false],
  ['普通消息 → 不点名', groupMsg([{ type: 'text', data: { text: '今天天气不错' } }], '今天天气不错'), false],
];

let failed = 0;
for (const [desc, msg, expected] of cases) {
  const actual = router.isDirectedAtAi(msg, msg.segments.map((s) => s.data?.text ?? '').join(''));
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${desc} → ${actual}（期望 ${expected}）`);
}
console.log(failed === 0 ? '\nALL DIRECTED CHECKS PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
