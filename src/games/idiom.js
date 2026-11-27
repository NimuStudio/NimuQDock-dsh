// 成语接龙：词库内置，判词离线，不需要联网
const WORDS = `一心一意 一马当先 一帆风顺 一举两得 一见如故 一日千里 一鸣惊人 一诺千金 一视同仁 一往无前 三心二意 三顾茅庐 三令五申 四面八方 四海为家 五湖四海 五光十色 六神无主 七上八下 八面玲珑 九牛一毛 十全十美 百发百中 百折不挠 千方百计 千军万马 万无一失 万事如意 万紫千红 万里长城 风平浪静 风和日丽 风起云涌 风雨同舟 风光无限 风华正茂 花好月圆 花团锦簇 花言巧语 草木皆兵 水落石出 水到渠成 水泄不通 山清水秀 山穷水尽 山盟海誓 高瞻远瞩 高谈阔论 高枕无忧 高朋满座 天长地久 天马行空 天真烂漫 天衣无缝 天下无双 人山人海 人才辈出 人定胜天 人杰地灵 人声鼎沸 心平气和 心旷神怡 心花怒放 心服口服 心领神会 心照不宣 心直口快 心甘情愿 心心相印 心猿意马 眼明手快 眼高手低 目瞪口呆 目中无人 目不转睛 目光如炬 耳濡目染 耳聪目明 手到擒来 手足无措 手忙脚乱 脚踏实地 足智多谋 智勇双全 勇往直前 前所未有 前因后果 前程似锦 后来居上 后生可畏 自强不息 自得其乐 自食其力 自由自在 自力更生 自言自語 理所当然 理直气壮 理屈词穷 名副其实 实事求是 是非分明 事半功倍 事在人为 事与愿违 一鼓作气 气势磅礴 气宇轩昂 气象万千 气息奄奄 惊天动地 惊心动魄 惊弓之鸟 惊涛骇浪 无与伦比 无微不至 无所不能 无中生有 无独有偶 无懈可击 画蛇添足 画龙点睛 画饼充饥 画地为牢 妙笔生花 妙不可言 妙手回春 笨鸟先飞 才高八斗 才华横溢 学富五车 学以致用 温故知新 举一反三 融会贯通 循序渐进 持之以恒 坚持不懈 锲而不舍 滴水穿石 青出于蓝 冰天雪地 冰清玉洁 雪中送炭 春暖花开 春意盎然 春风得意 夏日炎炎 秋高气爽 冬去春来 日新月异 日积月累 日理万机 日月如梭 光阴似箭 岁月如歌 星罗棋布 星火燎原 月明星稀 星月交辉 龙飞凤舞 龙腾虎跃 龙争虎斗 龙马精神 虎头蛇尾 虎视眈眈 狐假虎威 画虎类犬 守株待兔 狡兔三窟 亡羊补牢 羊肠小道 鸡飞狗跳 鸡犬不宁 鹤立鸡群 狗急跳墙 狼吞虎咽 杯弓蛇影 井底之蛙 塞翁失马 鱼贯而入 如鱼得水 鲤鱼跳龙门 鹏程万里 鸿鹄之志 燕雀安知 鸟语花香 莺歌燕舞 百鸟朝凤 凤毛麟角 金玉良言 金玉满堂 金榜题名 金枝玉叶 玉石俱焚 玉树临风 珠联璧合 珠光宝气 宝刀不老 刀山火海 火树银花 火中取栗 水中捞月 木已成舟 木秀于林 林深见鹿 根深蒂固 根深叶茂 叶落归根 归根结底 底朝天 脱颖而出 颖悟绝伦 绝处逢生 生机勃勃 生龙活虎 生花妙笔 笔走龙蛇 走马观花 马到成功 功成名就 成就非凡 非同小可 可歌可泣 可圈可点 点石成金 金石为开 开门见山 山高水长 长驱直入 入木三分 分秒必争 争先恐后 后来之秀 秀色可餐 餐风露宿 宿雨餐风 风调雨顺 顺理成章 章台杨柳 柳暗花明 明察秋毫 毫不犹豫 豫备不虞 虞人何罪 罪魁祸首 首屈一指 指鹿为马 马首是瞻 瞻前顾后 顾此失彼 彼此彼此 此起彼伏 伏案疾书 书声琅琅 琅琅上口 口若悬河 河清海晏 晏然自若 若无其事 事无巨细 细水长流 流连忘返 返璞归真 真相大白 白手起家 家喻户晓 晓以大义 义无反顾 顾名思义 思前想后 后顾之忧 忧心忡忡 忡忡不安 安然无恙 恙虫之患 患得患失 失之交臂 臂膀之力 力挽狂澜 澜沧江畔 畔上花开 开卷有益 益寿延年 年富力强 强人所难 难能可贵 贵人多忘事 事半功倍`.split(/\s+/).filter(Boolean);
const SET = new Set(WORDS);
const BY_FIRST = new Map();
for (const w of WORDS) {
  const c = w[0];
  if (!BY_FIRST.has(c)) BY_FIRST.set(c, []);
  BY_FIRST.get(c).push(w);
}
const norm = (s) => String(s || '').replace(/[\s，。！？、,.!?~～"“”'‘’《》<>【】()（）:：;；]/g, '');

export class IdiomChain {
  constructor({ bot, sender, cfg, log }) {
    this.bot = bot; this.sender = sender; this.cfg = cfg; this.log = log || (() => {});
    this.games = new Map();
  }
  get(key) { return this.games.get(key) || null; }
  dispose() { for (const g of this.games.values()) if (g.timer) clearTimeout(g.timer); this.games.clear(); }

  pick(requireFirst) {
    if (requireFirst) {
      const pool = BY_FIRST.get(requireFirst) || [];
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
      return null;
    }
    return WORDS[Math.floor(Math.random() * WORDS.length)];
  }

  async start(key, groupId) {
    if (this.games.has(key)) { await this.sender.notify(key, '本群已经在接龙了，要停就发 /game 2 stop。'); return; }
    if (WORDS.length < 50) { await this.sender.notify(key, '词库太小，先不开了。'); return; }
    const first = this.pick();
    const last = first[first.length - 1];
    const g = { key, groupId, chain: [first], need: last, scores: new Map(), misses: 0, timer: null, round: 1 };
    this.games.set(key, g);
    await this.sender.notify(key, [
      '成语接龙开始。',
      `我先来：「${first}」`,
      `接下来要「${last}」开头的成语，直接发在群里，45 秒没接上我替你们接。`,
    ].join('\n'));
    g.timer = setTimeout(() => this.timeout(g), 45_000);
    g.timer.unref?.();
  }

  async timeout(g) {
    if (this.games.get(g.key) !== g) return;
    g.misses = (g.misses || 0) + 1;
    const auto = this.pick(g.need);
    if (!auto) {
      await this.sender.notify(g.key, `「${g.need}」开头我词库里没有，这轮算我卡住，换一个：`);
      const fresh = this.pick();
      g.chain.push(fresh); g.need = fresh[fresh.length - 1]; g.misses = 0;
      await this.sender.notify(g.key, `新开头：「${fresh}」→ 要「${g.need}」`);
    } else {
      g.chain.push(auto); g.need = auto[auto.length - 1];
      await this.sender.notify(g.key, `没人接，我接：「${auto}」→ 接下来要「${g.need}」`);
    }
    if (g.misses >= 3) {
      await this.sender.notify(g.key, '连着 3 轮没人接，这局散了。' + this.scoreText(g));
      this.stop(g.key);
      return;
    }
    g.timer = setTimeout(() => this.timeout(g), 45_000);
    g.timer.unref?.();
  }

  async handleMessage(key, userId, name, text) {
    const g = this.games.get(key);
    if (!g) return false;
    const guess = norm(text);
    if (!guess || guess.length < 2 || guess.length > 8) return false;
    if (guess[0] !== g.need) {
      // 只提示明显在接龙但首字不对的
      if (guess.length === 4 && SET.has(guess)) {
        await this.sender.notify(key, `「${guess}」首字不是「${g.need}」，再想想。`);
        return true;
      }
      return false;
    }
    if (!SET.has(guess)) {
      await this.sender.notify(key, `「${guess}」我词库里没有，换一个「${g.need}」开头的。`);
      return true;
    }
    if (g.chain.includes(guess)) {
      await this.sender.notify(key, `「${guess}」用过了，换一个。`);
      return true;
    }
    if (g.timer) clearTimeout(g.timer);
    g.chain.push(guess); g.misses = 0; g.round += 1;
    g.scores.set(String(userId), (g.scores.get(String(userId)) || 0) + 10);
    g.need = guess[guess.length - 1];
    await this.sender.notify(key, `${name} 接上「${guess}」+10 → 接下来要「${g.need}」`);
    g.timer = setTimeout(() => this.timeout(g), 45_000);
    g.timer.unref?.();
    return true;
  }

  scoreText(g) {
    if (!g.scores.size) return '这局还没人得分。';
    const rank = [...g.scores.entries()].sort((a, b) => b[1] - a[1]);
    return '本局得分：\n' + rank.map(([id, s], i) => `${i + 1}. ${id} ${s} 分`).join('\n');
  }

  async stop(key) {
    const g = this.games.get(key);
    if (!g) { await this.sender.notify(key, '本群没有正在进行的接龙。'); return; }
    if (g.timer) clearTimeout(g.timer);
    this.games.delete(key);
    await this.sender.notify(key, '接龙结束。' + this.scoreText(g));
  }

  async command(key, groupId, text, { isAdmin }) {
    const parts = String(text || '').trim().split(/\s+/);
    let sub = (parts[1] || '').toLowerCase();
    if (['2', 'idiom', '成语', '接龙', '成语接龙'].includes(sub)) sub = (parts[2] || '').toLowerCase();
    if (!sub) { await this.sender.notify(key, '用法：/game 2 start | stop | skip | score'); return true; }
    if (sub === 'start' || sub === '开始') {
      if (!isAdmin) { await this.sender.notify(key, '只有群主 / 管理员能开游戏。'); return true; }
      await this.start(key, groupId); return true;
    }
    if (sub === 'stop' || sub === '结束') {
      if (!isAdmin) { await this.sender.notify(key, '只有群主 / 管理员能结束游戏。'); return true; }
      await this.stop(key); return true;
    }
    if (sub === 'skip' || sub === '跳过') {
      const g = this.games.get(key);
      if (!g) { await this.sender.notify(key, '本群没有正在进行的接龙。'); return true; }
      if (g.timer) clearTimeout(g.timer);
      await this.timeout(g); return true;
    }
    if (sub === 'score' || sub === '分数') {
      const g = this.games.get(key);
      await this.sender.notify(key, g ? this.scoreText(g) : '本群没有正在进行的接龙。'); return true;
    }
    await this.sender.notify(key, '用法：/game 2 start | stop | skip | score'); return true;
  }
}
