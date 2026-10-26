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

/** 停止从项目目录启动的进程。
 * 匹配策略（宁可多杀本项目进程，也不误杀用户自己的东西）：
 *  1) 可执行文件路径在项目目录内（便携 node / napcat / NapCatWinBootMain）；
 *  2) node.exe 且命令行是 main.js（桥接）或 napcat.mjs（NapCat）——它们的 cmdline 常是相对路径，
 *     不能用「命令行包含项目路径」来匹配；
 *  3) llama-server.exe 且命令行引用了本项目 models/ 里的模型（会 mmap 模型，占住文件）；
 *  4) 命令行里包含项目目录的其它进程（排除 powershell / cmd / 自身）。
 * 这样即使桥接是用系统 node + 相对路径启动的，也能停掉。 */
function stopProjectProcesses(projectDir) {
  try {
    const esc = String(projectDir).replace(/'/g, "''");
    const modelsEsc = String(path.join(projectDir, 'models')).replace(/'/g, "''");
    const cmd = `$procs = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -notin @('powershell.exe','pwsh.exe','conhost.exe','uninstall.exe','Au_.exe') -and $_.ProcessId -ne ${process.pid} -and ($_.CommandLine -notmatch 'uninstall\.mjs') -and (
        ($_.ExecutablePath -and $_.ExecutablePath -like "*${esc}*") -or
        ($_.Name -eq 'node.exe' -and $_.CommandLine -match '(^|[\\\\s"])main\\.js') -or
        ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'napcat\\.mjs') -or
        ($_.Name -eq 'llama-server.exe' -and $_.CommandLine -like "*${modelsEsc}*") -or
        ($_.CommandLine -and $_.CommandLine -like "*${esc}*")
      )
    };
    $all = @($procs);
    if($procs){
      $ids = @($procs | ForEach-Object { $_.ProcessId });
      $parents = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $ids -contains $_.ParentProcessId -and $_.CommandLine -match 'launcher-user|restart-napcat|start-napcat|napcat-launch' };
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

/** 把删除交给独立 PowerShell：等本进程退出后循环重试（处理文件占用 / 长路径）。
 * 结果写到 %TEMP%\nimu-uninstall.log，失败时用户能看到原因。 */
function deleteLater(dir) {
  try {
    const tmpDir = os.tmpdir();
    const script = path.join(tmpDir, `nimu-uninstall-${process.pid}.ps1`);
    const log = path.join(tmpDir, 'nimu-uninstall.log');
    const esc = (p) => String(p).replace(/'/g, "''");
    const ps = `$ErrorActionPreference='SilentlyContinue'
$dir='${esc(dir)}'
$log='${esc(log)}'
$empty=Join-Path $env:TEMP ('nimu-empty-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $empty -Force | Out-Null
"start $(Get-Date -Format s)" | Out-File -LiteralPath $log -Encoding UTF8
for ($i=0; $i -lt 90; $i++) {
  if (-not (Test-Path -LiteralPath $dir)) { "removed at attempt $i" | Out-File -LiteralPath $log -Append -Encoding UTF8; break }
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $dir) {
    # 长路径 / 顽固文件：先 robocopy 镜像空目录，再删
    robocopy $empty $dir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    cmd /c rmdir /s /q "$dir" | Out-Null
  }
  if (Test-Path -LiteralPath $dir) { Start-Sleep -Milliseconds 800 } else { "removed at attempt $i" | Out-File -LiteralPath $log -Append -Encoding UTF8; break }
}
if (Test-Path -LiteralPath $dir) { "FAILED: still exists" | Out-File -LiteralPath $log -Append -Encoding UTF8 }
Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath '${esc(script)}' -Force -ErrorAction SilentlyContinue`;
    fs.writeFileSync(script, ps, 'utf8');
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
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

  const autoYes = process.argv.includes('--yes');
  const confirm = autoYes
    ? 'y'
    : await ask('\n确认删除整个文件夹？此操作不可恢复（y/N）：');
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('已取消。');
    rl.close();
    process.exit(0);
  }

  const stopOnly = process.argv.includes('--stop-only');
  console.log('\n[1/3] 停止本项目相关进程 …');
  stopProjectProcesses(projectDir);
  await new Promise((r) => setTimeout(r, 1200));
  if (stopOnly) {
    console.log('✅ 已停止相关进程（仅停止，不删除）');
    rl.close();
    process.exit(0);
  }

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
    console.log(`⏳ 正在后台删除（${projectDir}）…`);
    console.log(`   若 1 分钟后文件夹仍在，可查看日志：${path.join(os.tmpdir(), 'nimu-uninstall.log')}`);
  }

  console.log('\n[3/3] 清理安装记录 …');
  try { fs.rmSync(path.dirname(INSTALL_RECORD), { recursive: true, force: true }); } catch {}
  console.log('✅ 卸载完成');
  divider();
  rl.close();
  process.exit(0);
}

main().catch((e) => { console.error('卸载出错:', e?.message ?? e); process.exit(1); });
