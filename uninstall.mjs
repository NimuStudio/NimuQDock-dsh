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

/** 停止「项目」自身的进程：桥接（node src/main.js）+ 项目内 NapCat。
 * 遵循「卸哪个杀哪个」：**不杀 DSH**（DSH 只在选 2 时停）；也绝不匹配 QQ / QQ音乐。
 * 返回是否停到了进程（没开进程时跳过提示，直接卸）。 */
function stopProjectProcesses(projectDir) {
  try {
    const esc = String(projectDir).replace(/'/g, "''");
    const cmd = `$procs = Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -match 'src[\\\\/]main\\\\.js' -or
      $_.CommandLine -match 'napcat|launcher-user|restart-napcat|start-napcat' -or
      $_.ExecutablePath -like '${esc}*'
    }; if($procs){ $n=0; $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; "STOPPED:$n" } else { 'NONE' }`;
    const out = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
    if ((out.stdout || '').match(/STOPPED:(\d+)/)) {
      const n = RegExp.$1;
      console.log(`✅ 已停止项目进程（桥接/NapCat ×${n}，不动 DSH/QQ）`);
      return n > 0;
    }
    console.log('ℹ️ 桥接/NapCat 未运行，跳过停止');
    return false;
  } catch {}
  return false;
}

/** 停止 DeepSeek Harness 进程（仅选 2「卸载 DSH」时使用）。返回是否停到了。 */
function stopDsh() {
  try {
    const cmd = `$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '@deepseek-ai[\\\\/]dsh|bin[\\\\/]dsh|\\.dsh[\\\\/]' }; if($procs){ $n=0; $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; "STOPPED:$n" } else { 'NONE' }`;
    const out = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
    if ((out.stdout || '').match(/STOPPED:(\d+)/)) {
      console.log(`✅ 已停止 DeepSeek Harness 进程 ×${RegExp.$1}`);
      return true;
    }
    console.log('ℹ️ DeepSeek Harness 未运行，跳过停止');
    return false;
  } catch {}
  return false;
}

/** 停止 NapCat 相关进程（仅选 3「卸载 NapCat」时使用）。不杀桥接/DSH/QQ/QQ音乐。返回是否停到了。 */
function stopNapCat(projectDir) {
  try {
    const esc = String(projectDir).replace(/'/g, "''");
    const cmd = `$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'napcat|launcher-user|restart-napcat|start-napcat' -or $_.ExecutablePath -like '${esc}*' }; if($procs){ $n=0; $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; "STOPPED:$n" } else { 'NONE' }`;
    const out = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
    if ((out.stdout || '').match(/STOPPED:(\d+)/)) {
      console.log(`✅ 已停止 NapCat 进程 ×${RegExp.$1}`);
      return true;
    }
    console.log('ℹ️ NapCat 未运行，跳过停止');
    return false;
  } catch {}
  return false;
}

/** 是否检测到 DeepSeek Harness 进程在运行（用于判断项目目录为何删不掉）。 */
function isDshRunning() {
  try {
    const out = spawnSync('powershell', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '@deepseek-ai[\\\\/]dsh|bin[\\\\/]dsh|\\.dsh[\\\\/]' }).Count`], { encoding: 'utf8' });
    return Number((out.stdout || '').trim()) > 0;
  } catch {}
  return false;
}

/** 延迟删除目录（detached PowerShell）。
 * 用 Remove-Item -Recurse -Force（能删只读文件，rd 不行）；等 2s 让外层 bat 释放 cwd，重试最多 30s。
 * 关键：目标路径（可能含中文/特殊字符）**先写入临时文件**，PowerShell 从文件读取，
 * 避免中文路径经命令行参数传参时被编码破坏（Windows 控制台 codepage 与 UTF-8 冲突）。
 * 临时文件路径本身是 ASCII（%TEMP%\\nimu-uninstall-<pid>.txt），命令行传它安全。 */
function deleteLater(dir) {
  try {
    const tmpList = path.join(os.tmpdir(), `nimu-uninstall-${process.pid}.txt`);
    fs.writeFileSync(tmpList, String(dir), 'utf8');
    const tmpEsc = tmpList.replace(/'/g, "''");
    const ps = `Start-Sleep -Seconds 2; $d=(Get-Content -LiteralPath '${tmpEsc}' -Raw -Encoding UTF8).Trim(); if($d){ for($i=0;$i -lt 30;$i++){ try{ Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop; break }catch{ Start-Sleep -Milliseconds 1000 } } }; Remove-Item -LiteralPath '${tmpEsc}' -Force -ErrorAction SilentlyContinue; if($d -and (Test-Path $d)){ Write-Host '⚠️ 部分文件仍存在:' $d }`;
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      detached: true, stdio: 'ignore', cwd: 'C:\\',
    });
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

  // 1) 按「卸哪个杀哪个」停止对应进程。
  //    项目(1)：只停桥接 + 项目内 NapCat，**不杀 DSH**（DSH 只在下方卸载 DSH 时停）。
  //    NapCat(3)：只停 NapCat。DSH(2)：只停 DSH。没开进程则跳过。
  if (picked.has('project')) {
    console.log('\n[停止相关进程]');
    stopProjectProcesses(projectDir);
  }

  // 2) 卸载 DSH
  if (picked.has('dsh')) {
    console.log('\n[卸载 DeepSeek Harness]');
    stopDsh();
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
    // 先停掉 NapCat 进程（node napcat.mjs / NapCatWinBootMain.exe / cmd 包装），否则目录被占删不掉。
    // 不杀用户 QQ / QQ音乐：它们在 QQ 安装目录，不占项目目录。
    stopNapCat(projectDir);
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

  // 5) 卸载项目
  if (picked.has('project')) {
    console.log('\n[卸载项目]');
    // 先切走本进程 cwd：node 的 cwd 也被 uninstall.bat 的 cd /d "%~dp0" 设成项目目录，
    // 不切走它自己就删不掉（进程 cwd 被占）。切到 C:\ 后 node 不再握着项目目录。
    try { process.chdir('C:\\'); } catch {}
    // 优先同步删除：切完 cwd 且没其它进程占着就能直接删掉
    let removed = false;
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
      removed = !fs.existsSync(projectDir);
    } catch {}
    if (removed) {
      console.log('✅ 安装目录已删除');
    } else if (isDshRunning()) {
      console.log(`⚠️ 目录没能删掉：${projectDir} 正被 DeepSeek Harness 占用（它从本项目目录运行，按你的要求本卸载不杀 DSH）。`);
      console.log('   若确实要删掉该目录：请在卸载菜单里也选上 [2] 卸载 DSH，或先自行停止 DSH 后重试。');
    } else {
      // 兜底：普通瞬态占用（如文件句柄未释放）→ 交给 detached 等窗口关闭后重试删
      deleteLater(projectDir);
      console.log(`⏳ 正在删除安装目录（${projectDir}）…（窗口关闭后自动完成）`);
    }
  }

  console.log('\n✅ 卸载完成！' + (picked.has('project') ? '项目目录已删除，或将在本窗口关闭后自动删除。' : ''));
  divider();
  rl.close();
  process.exit(0);
}

main().catch((e) => { console.error('卸载出错:', e?.message ?? e); process.exit(1); });
