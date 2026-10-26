// 命令行安装器（install.bat）：下载缺失组件。
// 图形安装器（exe 用的）在 install-ui.mjs；两边共用 src/installer/steps.js，避免逻辑漂移。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, installDshStep, installNapCatStep } from './src/installer/steps.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const divider = () => console.log('─'.repeat(56));

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) return true;
  console.log(`❌ Node.js 版本过低（当前 ${process.versions.node}），需要 18+。`);
  return false;
}

async function main() {
  divider();
  console.log('  🔌 NimuQDock-dsh · 安装（下载组件）');
  divider();
  console.log('  本步只下载缺失组件；装完双击 start.bat 填 QQ + 扫码即可开始使用。');

  console.log('\n[1/3] 检查 Node.js …');
  if (!checkNode()) { console.log('\n安装中断。'); return; }

  const state = await detect();

  console.log('\n[2/3] DeepSeek Harness …');
  if (state.dsh.usable) {
    console.log(`✅ 检测到本机已在运行 DSH（${state.dsh.protocol ?? '?'} 协议），直接复用，不重复下载`);
  } else if (state.dsh.localInstall) {
    console.log('✅ 本目录已装有便携 DSH（跳过下载）');
  } else {
    await installDshStep((m) => console.log('   ' + m));
  }

  console.log('\n[3/3] NapCat …');
  if (state.napcat.installed) {
    console.log('✅ NapCat 已存在（跳过下载）');
  } else {
    if (!state.qq.found) {
      console.log('⚠️ 没检测到 QQ 客户端：NapCat 装好后需要先安装 QQ 才能登录');
    }
    await installNapCatStep((m) => console.log('   ' + m));
  }

  console.log('\n✅ 组件安装完成！');
  console.log('  · 全部内容都在本目录，卸载只需删除目录（或运行 uninstall.bat）。');
  console.log('  · 想要更自然的接话判断，可双击 install-model.bat 下载模型（可选）。');

  // 装完直接接着启动（保持命令行体验）
  let go = false;
  if (process.stdin.isTTY) {
    try {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('现在启动 NimuQDock-dsh？[Y/n] ')).trim().toLowerCase();
      rl.close();
      go = answer === '' || answer === 'y' || answer === 'yes';
    } catch {
      go = false;
    }
  } else {
    go = true;
  }
  if (go) {
    const bat = path.join(ROOT, 'start.bat');
    if (fs.existsSync(bat)) {
      const { spawn } = await import('node:child_process');
      const child = spawn('cmd.exe', ['/c', bat], { cwd: ROOT, detached: true, stdio: 'ignore' });
      child.unref();
      console.log('🚀 已启动 start.bat（在新窗口里填写 QQ / 扫码登录）。');
    } else {
      console.log('未找到 start.bat，请检查安装目录是否完整。');
    }
  } else {
    console.log('  · 之后双击 start.bat 即可启动。');
  }
}

main().catch((error) => {
  console.error('安装引导出错:', error?.message ?? error);
  process.exit(1);
});
