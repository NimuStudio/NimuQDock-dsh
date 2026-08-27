#!/usr/bin/env node
// NapCat 连接自测：连 WS → get_login_info → get_group_list → get_status。
// 可选发一条测试消息后退出。
//
// 用法：
//   npm run test-onebot                                   # 连接并打印信息
//   npm run test-onebot -- --send-group 123456 "测试"      # 额外发一条群消息
//   npm run test-onebot -- --send-private 123456 "测试"    # 额外发一条私聊消息
import { loadConfig } from '../src/config.js';
import { OneBot11Client } from '../src/transport/onebot11.js';

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (error) {
    console.error(`[test-onebot] ${error?.message ?? error}`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const sendGroupIdx = args.indexOf('--send-group');
  const sendPrivateIdx = args.indexOf('--send-private');

  const bot = new OneBot11Client(cfg.napcat);

  bot.on('message', (msg) => {
    console.log(`[test-onebot] 收到 ${msg.kind} 消息（${msg.convId}）${msg.senderName}: ${msg.rawMessage.slice(0, 60)}`);
  });
  bot.on('error', (e) => console.log(`[test-onebot] WS 错误: ${e?.message ?? e}`));

  console.log(`[test-onebot] 连接 ${cfg.napcat.wsUrl} …`);
  try {
    await Promise.race([
      bot.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('10 秒内未连上 NapCat WebSocket')), 10000)),
    ]);
    console.log('[test-onebot] ✅ WebSocket 已连接');
  } catch (error) {
    console.error(`[test-onebot] ❌ ${error?.message ?? error}`);
    console.error('排查提示：NapCat WebUI → 网络配置 → 新建 WebSocket 服务端（端口与 config.json 的 napcat.wsUrl 一致），并确认 accessToken 一致。');
    process.exit(1);
  }

  try {
    const login = await bot.getLoginInfo();
    console.log(`[test-onebot] ✅ 登录信息：QQ ${login?.user_id}（${login?.nickname}）`);
    const status = await bot.getStatus();
    console.log(`[test-onebot] ✅ 状态：${JSON.stringify(status)}`);
    const groups = await bot.getGroupList();
    console.log(`[test-onebot] ✅ 群列表（${groups?.length ?? 0} 个）：`);
    for (const g of groups ?? []) console.log(`    ${g.group_id}  ${g.group_name}`);
  } catch (error) {
    console.error(`[test-onebot] ❌ HTTP 动作失败：${error?.message ?? error}`);
    console.error('排查提示：napcat.httpUrl 必须是 NapCat 的 OneBot11 HTTP 服务端口（不是 WebSocket 端口）。');
    bot.close();
    process.exit(1);
  }

  if (sendGroupIdx !== -1 && args[sendGroupIdx + 1] && args[sendGroupIdx + 2]) {
    try {
      const res = await bot.sendGroupMessage(args[sendGroupIdx + 1], args[sendGroupIdx + 2]);
      console.log(`[test-onebot] ✅ 群消息已发送（message_id: ${res?.message_id}）`);
    } catch (error) {
      console.error(`[test-onebot] ❌ 发送群消息失败：${error?.message ?? error}`);
    }
  }
  if (sendPrivateIdx !== -1 && args[sendPrivateIdx + 1] && args[sendPrivateIdx + 2]) {
    try {
      const res = await bot.sendPrivateMessage(args[sendPrivateIdx + 1], args[sendPrivateIdx + 2]);
      console.log(`[test-onebot] ✅ 私聊消息已发送（message_id: ${res?.message_id}）`);
    } catch (error) {
      console.error(`[test-onebot] ❌ 发送私聊消息失败：${error?.message ?? error}`);
    }
  }

  if (sendGroupIdx === -1 && sendPrivateIdx === -1) {
    console.log('[test-onebot] 监听 5 秒（期间收到消息会打印）…');
    await new Promise((r) => setTimeout(r, 5000));
  }
  bot.close();
  console.log('[test-onebot] 完成。');
  process.exit(0);
}

main().catch((error) => {
  console.error('[test-onebot] 失败:', error);
  process.exit(1);
});
