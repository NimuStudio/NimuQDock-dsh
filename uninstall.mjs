#!/usr/bin/env node
// NimuQDock-dsh 卸载程序（uninstall.exe / uninstall.bat 调用）。
// 从 %APPDATA%\NimuQDock-dsh\install-path.json 定位安装目录（install.mjs 安装时写入），
// 控制台菜单选择要卸载的内容（可多选）：
//   [1] NimuQDock-dsh 项目   [2] DeepSeek Harness   [3] NapCat
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_RECORD = path.join(os.homedir(), 'AppData', 'Roaming', 'NimuQDock-dsh', 'install-path.json');
const divider = () => console.log('─'.repeat(52));

/** 定位安装目录：优先安装记录，其次当前目录（uninstall.bat 在项目里双击时）。 */
function locateProject() {
  try {
    const rec = JSON.parse(fs.readFileSync(INSTALL_RECORD, 'utf8'));
    if (rec?.installPath && fs.existsSync(path.join(rec.installPath, 'package.json'))) return rec.installPath;
  } catch {}
  // 当前目录是项目（uninstall.bat 在项目根双击）
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
    if (pkg?.name === 'nimuqdock-dsh') return HERE;
  } catch {}
  return null;
}

/** 停止桥接进程。
 * 注意：start.bat 启动的 node 是相对路径（node src/main.js），CommandLine 不含绝对 projectDir；
 * 因此匹配 src/main.js（相对/绝对都命中），避免漏掉 start.bat 启动的桥接。 */
function stopBridge() {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\\\/]main\\\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { encoding: 'utf8' });
    console.log('✅ 已停止运行中的桥接进程');
  } catch {}
}

/** 延迟删除目录（先切到 C:\ 再 rd，避免删除自身 cwd 失败）。 */
function deleteLater(dir) {
  try {
    const clean = String(dir).replace(/"/g, '');
    const cmd = `timeout /t 2 >nul & cd /d C:\\ & rd /s /q "${clean}"`;
    const child = spawn('cmd', ['/c', cmd], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

async function main() {
  divider();
  console.log('  🗑️  NimuQDock-dsh 卸载程序');
  divider();

  const projectDir = locateProject();
  if (!projectDir) {
    console.log('❌ 未找到安装记录（%APPDATA%\\NimuQDock-dsh\\install-path.json），当前目录也不是项目。');
    console.log('   可手动删除项目目录完成卸载。');
    return;
  }
  console.log(`\n📁 检测到安装目录：${projectDir}`);

  // 菜单选择
  console.log('\n请选择要卸载的内容（可多选，用逗号分隔，直接回车 = 全部）：');
  console.log('  [1] NimuQDock-dsh 项目（删除安装目录）');
  console.log('  [2] DeepSeek Harness（npm 全局包 + ~/.dsh 数据）');
  console.log('  [3] NapCat（项目内 NapCatShell + QQ 登录配置）');
  const answer = await ask('输入编号（如 1,3）：');
  const picked = new Set();
  for (const c of (answer === '' ? '1,2,3' : answer).split(/[,，\s]+/)) {
    if (c === '1') picked.add('project');
    if (c === '2') picked.add('dsh');
    if (c === '3') picked.add('napcat');
  }
  if (!picked.size) { console.log('未选择任何内容，退出。'); rl.close(); process.exit(0); }

  console.log('\n即将卸载：');
  if (picked.has('project')) console.log('  - NimuQDock-dsh 项目');
  if (picked.has('dsh')) console.log('  - DeepSeek Harness');
  if (picked.has('napcat')) console.log('  - NapCat');
  const confirm = await ask('确认卸载以上内容？此操作不可恢复（y/N）：');
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') { console.log('已取消。'); rl.close(); process.exit(0); }

  // 1) 停止桥接（卸载项目/DSH 前）
  if (picked.has('project') || picked.has('dsh')) stopBridge();

  // 2) 卸载 DSH
  if (picked.has('dsh')) {
    console.log('\n[卸载 DeepSeek Harness]');
    try {
      const ls = spawnSync('npm', ['ls', '-g', '@deepseek-ai/dsh'], { encoding: 'utf8', shell: true });
      if (ls.status === 0) {
        const u = spawnSync('npm', ['uninstall', '-g', '@deepseek-ai/dsh'], { encoding: 'utf8', shell: true, timeout: 120000 });
        console.log(u.status === 0 ? '✅ 已卸载 npm 全局包 @deepseek-ai/dsh' : '⚠️ npm 卸载退出码 ' + u.status);
      } else {
        console.log('ℹ️ 未检测到 npm 全局安装（npx 缓存包由 npm 自动管理，无需手动删除）');
      }
    } catch (e) { console.log('⚠️ 卸载 DSH 包失败：' + e.message); }
    const dshHome = path.join(os.homedir(), '.dsh');
    if (fs.existsSync(dshHome)) {
      try { fs.rmSync(dshHome, { recursive: true, force: true }); console.log('✅ 已删除 ~/.dsh（含 preset / MCP / 插件配置）'); }
      catch (e) { console.log('⚠️ 删除 ~/.dsh 失败：' + e.message); }
    }
  }

  // 3) 卸载 NapCat
  if (picked.has('napcat')) {
    console.log('\n[卸载 NapCat]');
    // 先停掉 NapCat / QQ 相关进程，否则目录被占用删不掉
    try {
      spawnSync('taskkill', ['/f', '/im', 'NapCatWinBootMain.exe'], { stdio: 'ignore' });
      spawnSync('taskkill', ['/f', '/im', 'NapCatWinBootHook.dll'], { stdio: 'ignore' });
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    const napcatDir = path.join(projectDir, 'NapCatShell');
    if (fs.existsSync(napcatDir)) {
      try { fs.rmSync(napcatDir, { recursive: true, force: true }); console.log('✅ 已删除 NapCatShell（含 QQ 登录配置）'); }
      catch (e) { console.log('⚠️ 删除 NapCatShell 失败（请手动删除）：' + e.message); }
    } else {
      console.log('ℹ️ 未在项目目录发现 NapCatShell');
    }
  }

  // 4) 清理安装记录
  try { fs.rmSync(path.dirname(INSTALL_RECORD), { recursive: true, force: true }); } catch {}

  // 5) 卸载项目（延迟删除：卸载器自身进程先退出释放 cwd，detached cmd 稍后 rd）
  if (picked.has('project')) {
    console.log('\n[卸载项目]');
    deleteLater(projectDir);
    console.log(`⏳ 正在删除安装目录（${projectDir}）…`);
  }

  console.log('\n✅ 卸载完成！' + (picked.has('project') ? '项目目录将在本窗口关闭后自动删除。' : ''));
  divider();
  // 关键：先关闭 readline 并退出，释放本进程对 projectDir 的 cwd 占用，
  // 否则延迟删除的 rd 会因目录被本进程持有而失败
  rl.close();
  process.exit(0);
}

main().catch((e) => { console.error('卸载出错:', e?.message ?? e); process.exit(1); });
