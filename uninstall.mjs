#!/usr/bin/env node
// NimuQDock-dsh 卸载程序（uninstall.bat 调用）。
// 新模型：我们帮用户装了什么（本项目 + 便携 DSH + NapCat）就全在一个文件夹里，
// 卸载 = 停掉从该文件夹启动的进程 + 删除整个文件夹。不碰用户自己的 DSH / NapCat。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_RECORD = path.join(os.homedir(), 'AppData', 'Roaming', 'NimuQDock-dsh', 'install-path.json');
const divider = () => console.log('─'.repeat(52));

/** 定位项目目录：以本脚本所在目录为准（uninstall.mjs 就在项目根）。 */
function locateProject() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
    if (pkg?.name === 'nimuqdock-dsh') return HERE;
  } catch {}
  return null;
}

/** 停止从项目目录启动的进程（桥接 / 便携 DSH / NapCat 及其 cmd 包装）。
 * 关键：用「精确特征」匹配，绝不用 `CommandLine -like "*项目目录*"` 这种宽泛匹配——
 * 否则会连卸载脚本自己（node "<项目目录>\uninstall.mjs"，绝对路径含目录名）和它的 cmd 包装一起杀掉，
 * 导致脚本还没走到删除就死掉、文件夹删不掉。 */
function stopProjectProcesses(projectDir) {
  try {
    const esc = String(projectDir).replace(/'/g, "''");
    const cmd = `$procs = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -notin @('powershell.exe','pwsh.exe','conhost.exe') -and $_.ProcessId -ne ${process.pid} -and (
        ($_.CommandLine -match 'src[\\\\/]main\\.js' -and $_.CommandLine -like "*${esc}*") -or
        ($_.CommandLine -match 'node_modules[\\\\/]@deepseek-ai[\\\\/]dsh' -and $_.CommandLine -like "*${esc}*") -or
        ($_.CommandLine -match 'napcat\\.mjs|NapCatWinBootMain' -and $_.CommandLine -like "*${esc}*") -or
        $_.ExecutablePath -like "*${esc}*"
      )
    };
    $all = @($procs);
    if($procs){
      $ids = @($procs | ForEach-Object { $_.ProcessId });
      $parents = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $ids -contains $_.ParentProcessId -and $_.CommandLine -match 'launcher-user|restart-napcat|start-napcat' };
      $all = @($procs) + @($parents);
    }
    if($all.Count){ $n=0; $all | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; "STOPPED:$n" } else { 'NONE' }`;
    const out = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
    if ((out.stdout || '').match(/STOPPED:(\d+)/)) {
      console.log(`✅ 已停止本项目相关进程 ×${RegExp.$1}`);
    } else {
      console.log('ℹ️ 本项目相关进程未运行，直接卸载');
    }
  } catch {}
}

/** 延迟删除目录（detached PowerShell；路径先写临时文件规避中文路径编码问题）。 */
function deleteLater(dir) {
  try {
    const tmpList = path.join(os.tmpdir(), `nimu-uninstall-${process.pid}.txt`);
    fs.writeFileSync(tmpList, String(dir), 'utf8');
    const tmpEsc = tmpList.replace(/'/g, "''");
    const ps = `Start-Sleep -Seconds 2; $d=(Get-Content -LiteralPath '${tmpEsc}' -Raw -Encoding UTF8).Trim(); if($d){ for($i=0;$i -lt 30;$i++){ try{ Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop; break }catch{ Start-Sleep -Milliseconds 1000 } } }; Remove-Item -LiteralPath '${tmpEsc}' -Force -ErrorAction SilentlyContinue`;
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

  // 优先用命令行传入的项目目录（uninstall.bat 把 node/uninstall 拷到临时目录运行时传参）；
  // 否则以本脚本所在目录为准。
  const argDir = process.argv[2] ? path.resolve(String(process.argv[2]).replace(/[\\/]+$/, '')) : null;
  const projectDir = (argDir && fs.existsSync(path.join(argDir, 'package.json'))) ? argDir : locateProject();
  if (!projectDir) {
    console.log('❌ 未找到项目目录（当前脚本不在项目根）。');
    return;
  }
  console.log(`\n📁 将卸载：${projectDir}`);
  console.log('   这会把我们装进去的【项目 + 便携 DSH + NapCat】一起删掉。');
  console.log('   不会动你本机自己的 DSH / NapCat（它们不在这个文件夹里）。');

  const confirm = await ask('\n确认删除整个文件夹？此操作不可恢复（y/N）：');
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('已取消。');
    rl.close();
    process.exit(0);
  }

  console.log('\n[1/3] 停止本项目相关进程 …');
  stopProjectProcesses(projectDir);
  await new Promise((r) => setTimeout(r, 1200));

  console.log('\n[2/3] 删除文件夹 …');
  try { process.chdir('C:\\'); } catch {}
  let removed = false;
  try {
    fs.rmSync(projectDir, { recursive: true, force: true });
    removed = !fs.existsSync(projectDir);
  } catch {}
  if (removed) {
    console.log('✅ 文件夹已删除');
  } else {
    deleteLater(projectDir);
    console.log(`⏳ 正在删除（${projectDir}）…（窗口关闭后自动完成）`);
  }

  console.log('\n[3/3] 清理安装记录 …');
  try { fs.rmSync(path.dirname(INSTALL_RECORD), { recursive: true, force: true }); } catch {}
  console.log('✅ 卸载完成');
  divider();
  rl.close();
  process.exit(0);
}

main().catch((e) => { console.error('卸载出错:', e?.message ?? e); process.exit(1); });
