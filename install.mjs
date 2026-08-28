#!/usr/bin/env node
// NimuQDock-dsh 一键安装引导（Windows 双击 install.bat 或直接 node install.mjs）。
// 做的事：
//   1. 检查 Node.js 版本（≥ 22.13）
//   2. 若缺 config.json，从 config.example.json 生成并提示填写
//   3. 检查依赖（node_modules 缺失时 npm install）
//   4. 检测 NapCat（OneBot WS 3001）与 DeepSeek Harness（3080）是否就绪
//   5. 提示下一步（start.bat / npm start）
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // install.mjs 位于项目根目录
const divider = () => console.log('─'.repeat(52));

function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { try { socket.destroy(); } catch {} resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

function checkNode() {
  const major = Number(process.version.slice(1).split('.')[0]);
  if (major < 22) {
    console.log(`❌ Node.js 版本过低：${process.version}（需要 ≥ 22.13）`);
    console.log('   请到 https://nodejs.org 下载最新 LTS 安装后重试。');
    return false;
  }
  console.log(`✅ Node.js ${process.version}`);
  return true;
}

function ensureConfig() {
  const cfg = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfg)) {
    console.log('✅ config.json 已存在（跳过生成）');
    return;
  }
  try {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), cfg);
    console.log('✅ 已生成 config.json');
    console.log('   ⚠️ 请用编辑器打开它，至少填写：ownerQQ（你的 QQ）、allow.private / allow.groups（白名单）');
  } catch (error) {
    console.log(`❌ 生成 config.json 失败：${error?.message ?? error}`);
  }
}

function ensureDeps() {
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'yaml'))
      && fs.existsSync(path.join(ROOT, 'node_modules', '@deepseek-ai'))) {
    console.log('✅ 依赖已就绪（node_modules 完整）');
    return true;
  }
  console.log('⏳ 依赖缺失，执行 npm install …（可能需要几分钟）');
  const result = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.log('❌ npm install 失败，请检查网络后重试。');
    return false;
  }
  console.log('✅ 依赖安装完成');
  return true;
}

async function main() {
  divider();
  console.log('  🔌 NimuQDock-dsh · 一键安装引导');
  divider();

  console.log('\n[1/5] 检查 Node.js …');
  if (!checkNode()) { console.log('\n安装中断。'); return; }

  console.log('\n[2/5] 准备 config.json …');
  ensureConfig();

  console.log('\n[3/5] 检查依赖 …');
  if (!ensureDeps()) { console.log('\n安装中断。'); return; }

  console.log('\n[4/5] 检测运行环境 …');
  const napcatOk = await probePort(3001);
  const dshOk = await probePort(3080);
  if (dshOk) console.log('✅ DeepSeek Harness 已运行（http://127.0.0.1:3080）');
  else console.log('❌ DeepSeek Harness 未运行。请先启动它：');
  console.log('      npx @deepseek-ai/dsh web     （浏览器打开 127.0.0.1:3080 能看到界面即成功）');
  if (napcatOk) console.log('✅ NapCat 已就绪（OneBot WS 3001 / HTTP 3000）');
  else console.log('❌ NapCat 未就绪（3001 端口未开放）。请：');
  console.log('      1) 下载 NapCat（https://github.com/NapNeko/NapCatQQ/releases/latest，Windows 用 Shell 版）');
  console.log('      2) 安装 QQ 客户端并用 NapCat 扫码登录');
  console.log('      3) WebUI http://127.0.0.1:6099/webui 配置 OneBot11：HTTP 3000 + WS 3001，消息格式 array');

  console.log('\n[5/5] 完成！');
  if (dshOk && napcatOk) {
    console.log('   环境已就绪，双击 start.bat（守护模式）或运行 npm start 即可启动；');
    console.log('   桥接启动后会自动打开 Web 控制台。');
  } else {
    console.log('   上面有 ❌ 的项目先处理好，再双击 start.bat 启动。');
  }
  console.log('\n更多说明见 README.md，配置字段见 config.json。');
}

main().catch((error) => {
  console.error('安装引导出错:', error?.message ?? error);
  process.exit(1);
});
