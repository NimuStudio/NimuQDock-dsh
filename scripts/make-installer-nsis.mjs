// 构建原生安装器（NSIS）：收集 payload → 调 makensis 生成 exe。
//
// 用法：
//   node scripts/make-installer-nsis.mjs [版本号] [输出目录]
// 环境变量：
//   MAKENSIS  指定 makensis 路径（默认 PATH 里的 makensis / makensis.exe）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const outDir = path.resolve(ROOT, process.argv[3] ?? 'dist');
const payload = path.join(outDir, 'nsis-payload');

const ROOT_FILES = [
  'package.json', 'package-lock.json', 'config.example.json',
  'start.bat', 'start.mjs', 'restart.bat', 'install-model.bat', 'uninstall.mjs', 'uninstall.bat',
  'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md',
];
const TOP_DIRS = ['src', 'public', 'plugins', 'dsh', 'roles', 'node_modules'];
const SCRIPT_ALLOW = [
  'setup-dsh.mjs', 'fetch-judge-model.mjs',
  'nsis-detect.mjs', 'nsis-install-items.mjs',
];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function main() {
  fs.rmSync(payload, { recursive: true, force: true });
  fs.mkdirSync(payload, { recursive: true });

  for (const f of ROOT_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(payload, f));
  }
  for (const d of TOP_DIRS) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) copyDir(src, path.join(payload, d));
  }
  const scriptsDir = path.join(ROOT, 'scripts');
  fs.mkdirSync(path.join(payload, 'scripts'), { recursive: true });
  for (const f of SCRIPT_ALLOW) {
    const src = path.join(scriptsDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(payload, 'scripts', f));
  }

  // 便携 node（CI 会先准备 node/；本地没有则报错，避免做出不能用的安装包）
  const nodeDir = path.join(ROOT, 'node');
  if (!fs.existsSync(path.join(nodeDir, 'node.exe'))) {
    console.error('[installer] 缺少 node\\node.exe（先准备便携 node，或 CI 里会自动下载）');
    process.exit(1);
  }
  copyDir(nodeDir, path.join(payload, 'node'));

  const makensis = process.env.MAKENSIS
    || (process.platform === 'win32' ? 'makensis.exe' : 'makensis');
  const nsi = path.join(ROOT, 'installer', 'installer.nsi');
  const sep = process.platform === 'win32' ? '\\' : '/';
  // makensis 在 POSIX 上只认 -D；Windows 用 /D
  const d = process.platform === 'win32' ? '/D' : '-D';
  const args = [
    `${d}APP_VERSION=${version}`,
    `${d}SEP=${sep}`,
    `${d}PAYLOAD=${payload}`,
    `${d}OUTFILE=${path.join(outDir, `NimuQDock-dsh-${version}-setup.exe`)}`,
    nsi,
  ];
  console.log(`[installer] makensis ${args.slice(0, 3).join(' ')} …`);
  const r = spawnSync(makensis, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) {
    console.error('[installer] makensis 失败');
    process.exit(r.status ?? 1);
  }
  const exe = path.join(outDir, `NimuQDock-dsh-${version}-setup.exe`);
  console.log(`[installer] ✅ ${exe}（${(fs.statSync(exe).size / 1048576).toFixed(1)} MB）`);
}

main();
