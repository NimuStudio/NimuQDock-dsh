/**
 * 你画我猜 · 主持人模式（P0）
 *
 * 机器人不画、不猜，只做主持人：出题、私聊告诉画的人、计时、判分、报答案。
 * 状态机是确定性的，不靠大模型，所以快、稳、便宜。
 */
const WORDS = [
  '太阳','月亮','彩虹','雪人','雨伞','气球','蛋糕','冰淇淋','西瓜','苹果',
  '香蕉','葡萄','猫','狗','兔子','熊猫','大象','长颈鹿','企鹅','章鱼',
  '蝴蝶','乌龟','蜗牛','鲨鱼','恐龙','飞机','火车','自行车','轮船','热气球',
  '房子','桥','灯塔','城堡','帐篷','钥匙','眼镜','帽子','雨靴','口罩',
  '手机','电脑','键盘','台灯','闹钟','剪刀','梳子','牙刷','杯子','锅',
  '吉他','钢琴','篮球','足球','风筝','秋千','滑梯','摩天轮','烟花','星星',
  '火锅','寿司','汉堡','面条','饺子','糖葫芦','奶茶','咖啡','西瓜霜','辣椒',
  '医生','警察','消防员','宇航员','厨师','老师','理发师','魔术师','宇航服','潜水艇',
];

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?~～…—\-_/\\'"“”‘’()（）\[\]【】]+/g, '');
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export class DrawGuess {
  constructor({ bot, sender, cfg, log }) {
    this.bot = bot;
    this.sender = sender;
    this.cfg = cfg;
    this.log = log ?? (() => {});
    this.games = new Map(); // key -> game
  }

  get(key) {
    return this.games.get(key) ?? null;
  }

  info() {
    return [...this.games.entries()].map(([key, g]) => `${key} 第${g.round}轮 剩${Math.max(0, Math.round((g.endAt - Date.now()) / 1000))}秒`).join('\n');
  }

  async start(key, groupId, byName = '') {
    if (this.games.has(key)) {
      const g = this.games.get(key);
      await this.sender.notify(key, `本群已经有一局在玩了（第 ${g.round} 轮）。要重开先发 /game stop`);
      return;
    }
    let members = [];
    try {
      members = (await this.bot.getGroupMemberList(groupId)) ?? [];
    } catch (e) {
      this.log(`[game] 取群成员失败：${e?.message ?? e}`);
    }
    const selfId = String(this.bot.selfId ?? '');
    let friends = new Set();
    try {
      const fl = await this.bot.action('get_friend_list', {});
      friends = new Set((Array.isArray(fl) ? fl : []).map((f) => String(f.user_id)));
    } catch (e) { this.log?.('取好友列表失败：' + e.message); }
    const players = members
      .filter((m) => m && m.user_id != null)
      .filter((m) => String(m.user_id) !== selfId)          // 别把自己选成画手
      .filter((m) => friends.size === 0 || friends.has(String(m.user_id)))  // 只挑能私聊的
      .map((m) => ({ id: String(m.user_id), name: m.card || m.nickname || String(m.user_id) }));
    if (players.length < 2) {
      await this.sender.notify(key, `群里能玩的人不够（不算我自己只有 ${players.length} 个），先攒点人再玩。`);
      return;
    }
    const g = {
      key,
      groupId: String(groupId),
      round: 0,
      used: new Set(),
      scores: new Map(),
      players,
      endAt: 0,
      timer: null,
      word: '',
      drawer: null,
    };
    this.games.set(key, g);
    await this.sender.notify(key, `你画我猜开始（${players.length} 人）。规则：我私聊告诉一个人画什么，其他人直接发猜的词；猜中 +10 分，画的人 +5 分，90 秒一轮。`);
    await this.nextRound(g);
  }

  async nextRound(g) {
    if (g.timer) clearTimeout(g.timer);
    let word = pick(WORDS);
    for (let i = 0; i < 20 && g.used.has(word); i += 1) word = pick(WORDS);
    g.used.add(word);
    g.word = word;
    g.round += 1;
    // 轮流当画手：按轮次取模，避免总是同一个人
    g.drawer = g.players[(g.round - 1) % g.players.length];
    if (String(g.drawer.id) === String(this.bot.selfId ?? '')) {
      g.drawer = g.players[g.round % g.players.length];
    }
    g.endAt = Date.now() + 90_000;
    try {
      if (g.drawer.id !== (this.bot.selfId ?? '')) {
        await this.bot.sendPrivateMessage(g.drawer.id, [
          { type: 'text', data: { text: `第 ${g.round} 轮，你来画：${word}\n（90 秒，直接发到群里，别打出来）` } },
        ]);
      }
    } catch (e) {
      this.log(`[game] 私聊画手失败：${e?.message ?? e}`);
      await this.sender.notify(key, `给 ${g.drawer.name} 发私聊失败了（多半是没加我好友），这局先停。把我加好友后再 /game start。`);
      this.stop(key);
      return;
    }
    await this.sender.notify(g.key, `第 ${g.round} 轮开始：${g.drawer.name} 来画，其他人抢答。`);
    g.timer = setTimeout(() => this.timeout(g), 90_000);
    g.timer.unref?.();
  }

  async timeout(g) {
    if (this.games.get(g.key) !== g) return;
    g.silentRounds = (g.silentRounds ?? 0) + 1;
    await this.sender.notify(g.key, `时间到，答案是「${g.word}」。`);
    if (g.silentRounds >= 3) {
      await this.sender.notify(g.key, '连着 3 轮没人猜中，这局先散了。想玩再发 /game start。');
      await this.stop(g.key);
      return;
    }
    await this.nextRound(g);
  }

  /** 返回 true 表示这条消息被游戏消费掉了（不要再交给模型）。 */
  async handleMessage(key, userId, name, text) {
    const g = this.games.get(key);
    if (!g) return false;
    const guess = norm(text);
    if (!guess || guess.length > 20) return false;
    if (g.drawer && String(g.drawer.id) === String(userId)) return false; // 画手不能猜
    const target = norm(g.word);
    // 允许「是眼镜吧」「眼镜！」这种带前后缀的猜法，但别让整句话都被当成答案
    const hit = guess === target || (guess.includes(target) && guess.length <= target.length + 2);
    if (!hit) return false;
    const prev = g.scores.get(String(userId)) ?? 0;
    g.scores.set(String(userId), prev + 10);
    const drawerPrev = g.scores.get(String(g.drawer.id)) ?? 0;
    g.scores.set(String(g.drawer.id), drawerPrev + 5);
    if (g.timer) clearTimeout(g.timer);
    g.silentRounds = 0;
    await this.sender.notify(g.key, `${name} 猜中了「${g.word}」！+10（画手 ${g.drawer.name} +5）`);
    await this.nextRound(g);
    return true;
  }

  async stop(key) {
    const g = this.games.get(key);
    if (!g) {
      await this.sender.notify(key, '本群没有正在进行的游戏。');
      return;
    }
    if (g.timer) clearTimeout(g.timer);
    this.games.delete(key);
    await this.sender.notify(key, `游戏结束。${this.scoreText(g)}`);
  }

  scoreText(g) {
    if (!g.scores.size) return '这局没人得分。';
    const rank = [...g.scores.entries()].sort((a, b) => b[1] - a[1]);
    return '本局得分：\n' + rank.map(([id, s], i) => {
      const p = g.players.find((x) => x.id === id);
      return `${i + 1}. ${p?.name ?? id} ${s} 分`;
    }).join('\n');
  }

  /** /game 指令入口；返回 true 表示已处理。 */
  async command(key, groupId, text, { isAdmin }) {
    const parts = String(text ?? '').trim().split(/\s+/);
    const GAMES = [
      { id: 'draw', no: '1', names: ['draw', '画', '你画我猜', 'drawguess'], title: '你画我猜', desc: '我私聊画手发词，其他人发词猜，猜中 +10、画手 +5' },
    ];
    const menu = [
      '可以玩的游戏：',
      ...GAMES.map((g) => `${g.no}. ${g.title} —— ${g.desc}`),
      '',
      '用法：/game <编号或名字> <开始|结束|跳过|分数>',
      '例：/game 1 start · /game 1 stop · /game 1 skip · /game 1 score',
      '（不带编号默认第 1 个；猜的人直接发词，不用加指令）',
    ].join('\n');
    let sub = (parts[1] ?? '').toLowerCase();
    const pick = GAMES.find((g) => g.no === sub || g.names.includes(sub));
    if (pick) sub = (parts[2] ?? '').toLowerCase();
    if (!sub) {
      await this.sender.notify(key, menu);
      return true;
    }
    if (sub === 'start' || sub === '开始') {
      if (!isAdmin) {
        await this.sender.notify(key, '只有群主 / 管理员能开游戏。');
        return true;
      }
      await this.start(key, groupId);
      return true;
    }
    if (sub === 'stop' || sub === '结束') {
      if (!isAdmin) {
        await this.sender.notify(key, '只有群主 / 管理员能结束游戏。');
        return true;
      }
      await this.stop(key);
      return true;
    }
    if (sub === 'skip' || sub === '跳过') {
      const g = this.games.get(key);
      if (!g) {
        await this.sender.notify(key, '本群没有正在进行的游戏。');
        return true;
      }
      await this.sender.notify(key, `跳过。答案是「${g.word}」。`);
      await this.nextRound(g);
      return true;
    }
    if (sub === 'score' || sub === '分数') {
      const g = this.games.get(key);
      await this.sender.notify(key, g ? this.scoreText(g) : '本群没有正在进行的游戏。');
      return true;
    }
    await this.sender.notify(key, menu);
    return true;
    await this.sender.notify(key, [
      '你画我猜：',
      '/game start — 开始（群主 / 管理员）',
      '/game skip — 跳过本轮',
      '/game score — 看分数',
      '/game stop — 结束并结算',
    ].join('\n'));
    return true;
  }

  /** 进程退出前清理计时器 */
  dispose() {
    for (const g of this.games.values()) if (g.timer) clearTimeout(g.timer);
    this.games.clear();
  }
}
