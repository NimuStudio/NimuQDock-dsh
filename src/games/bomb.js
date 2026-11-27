// 数字炸弹：1~100 里藏一个炸弹，谁报到谁输
const normNum = (s) => {
  const m = String(s || '').replace(/[\s，。！？、,.!?~～]/g, '').match(/^(\d{1,3})$/);
  return m ? Number(m[1]) : null;
};

export class NumberBomb {
  constructor({ bot, sender, cfg, log }) {
    this.bot = bot; this.sender = sender; this.cfg = cfg; this.log = log || (() => {});
    this.games = new Map();
  }
  get(key) { return this.games.get(key) || null; }
  dispose() { for (const g of this.games.values()) if (g.timer) clearTimeout(g.timer); this.games.clear(); }

  async start(key, groupId) {
    if (this.games.has(key)) { await this.sender.notify(key, '本群已经在玩了，要停就发 /game 3 stop。'); return; }
    const bomb = 1 + Math.floor(Math.random() * 100);
    const g = { key, groupId, bomb, lo: 1, hi: 100, scores: new Map(), misses: 0, round: 0, timer: null };
    this.games.set(key, g);
    await this.sender.notify(key, [
      '数字炸弹开始。',
      '我在 1~100 里藏了一个数，大家轮流报数，谁报到谁输（-5 分，其他人 +5）。',
      '直接发数字，我会回「大了」或「小了」。',
    ].join('\n'));
    g.timer = setTimeout(() => this.timeout(g), 90_000);
    g.timer.unref?.();
  }

  async timeout(g) {
    if (this.games.get(g.key) !== g) return;
    g.misses = (g.misses || 0) + 1;
    if (g.misses >= 3) {
      await this.sender.notify(g.key, `连着没人报数，炸弹是「${g.bomb}」，这局散了。` + this.scoreText(g));
      this.stop(g.key);
      return;
    }
    await this.sender.notify(g.key, `没人报数，范围还是 ${g.lo}~${g.hi}。`);
    g.timer = setTimeout(() => this.timeout(g), 90_000);
    g.timer.unref?.();
  }

  async handleMessage(key, userId, name, text) {
    const g = this.games.get(key);
    if (!g) return false;
    const n = normNum(text);
    if (n == null) return false;
    if (n < g.lo || n > g.hi) {
      await this.sender.notify(key, `${n} 不在范围里，现在是 ${g.lo}~${g.hi}。`);
      return true;
    }
    if (g.timer) clearTimeout(g.timer);
    g.misses = 0; g.round += 1;
    g.scores.set(String(userId), g.scores.get(String(userId)) || 0);
    if (n === g.bomb) {
      g.scores.set(String(userId), (g.scores.get(String(userId)) || 0) - 5);
      for (const [id, s] of g.scores.entries()) if (id !== String(userId)) g.scores.set(id, s + 5);
      await this.sender.notify(key, `💥 ${name} 报到 ${n}，炸弹炸了！-5 分，其他人 +5。`);
      await this.stop(key);
      return true;
    }
    if (n < g.bomb) g.lo = Math.max(g.lo, n + 1);
    else g.hi = Math.min(g.hi, n - 1);
    await this.sender.notify(key, `${n}：${n < g.bomb ? '小了' : '大了'}，范围缩小到 ${g.lo}~${g.hi}`);
    g.timer = setTimeout(() => this.timeout(g), 90_000);
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
    if (!g) { await this.sender.notify(key, '本群没有正在进行的数字炸弹。'); return; }
    if (g.timer) clearTimeout(g.timer);
    this.games.delete(key);
    await this.sender.notify(key, '游戏结束。' + this.scoreText(g));
  }

  async command(key, groupId, text, { isAdmin }) {
    const parts = String(text || '').trim().split(/\s+/);
    let sub = (parts[1] || '').toLowerCase();
    if (['3', 'bomb', '数字', '炸弹', '数字炸弹'].includes(sub)) sub = (parts[2] || '').toLowerCase();
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
      if (!g) { await this.sender.notify(key, '本群没有正在进行的数字炸弹。'); return true; }
      await this.sender.notify(key, `跳过这局，炸弹是「${g.bomb}」。`); await this.stop(key); return true;
    }
    if (sub === 'score' || sub === '分数') {
      const g = this.games.get(key);
      await this.sender.notify(key, g ? this.scoreText(g) : '本群没有正在进行的数字炸弹。'); return true;
    }
    await this.sender.notify(key, '用法：/game 3 start | stop | skip | score'); return true;
  }
}
