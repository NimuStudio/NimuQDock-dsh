// 发布打包：生成 UTF-8 文件名的 zip（替代 7za/tar 在 Windows 的 GBK 文件名问题）。
// 用法: node scripts/make-release-zip.mjs <tag名> <输出zip>
// 例:   node scripts/make-release-zip.mjs v0.2.0 dist/NimuQDock-dsh-v0.2.0-win-x64.zip
// 依赖: yazl（devDependencies）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tag, out] = process.argv.slice(2);
if (!tag || !out) { console.error('usage: node scripts/make-release-zip.mjs <tag> <out.zip>'); process.exit(1); }

// ── 运行时最小包：只装「跑起来」需要的，开发/文档/发布脚本一律不进安装包 ──
// 注意：以下仓库级目录只在【仓库根一级】排除。绝不能在全树按名字排除——
// node_modules（含内置便携 node 的 npm）里有大量依赖把代码放在 dist/ 目录，
// 按名删会把它们删成残废（实测 npm 的 walk-up-path 依赖 dist/cjs 被删 → npm 崩）。
const EXCLUDE_TOP_DIRS = new Set([
  '.git', '.github', 'state', 'dist', 'docs', 'assets', 'tests', 'scripts',
]);
const EXCLUDE_FILES = new Set(['config.json']);
const EXCLUDE_EXT = new Set(['.log', '.tmp']);
// 根目录可用文件白名单：只保留运行/安装/维护必需
const ROOT_ALLOW = new Set([
  'package.json', 'package-lock.json', 'config.example.json',
  'README.md', 'README.en.md', 'LICENSE',
  'install.bat', 'install.mjs', 'uninstall.bat', 'uninstall.mjs',
  'start.bat', 'start.mjs', 'restart.bat',
]);

function walk(dir, base, list) {
  const relDir = base || '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      // 仅仓库根一级排除开发目录；依赖树内（node_modules / 便携 node 等）一律保留
      if (!relDir && EXCLUDE_TOP_DIRS.has(entry.name)) continue;
      if (relDir && (entry.name === '.git' || entry.name === '.github')) continue;
      walk(abs, rel, list);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (EXCLUDE_EXT.has(ext)) continue;
      if (!relDir) {
        // 根目录文件：排除 config.json（含隐私）+ 只放行白名单
        if (EXCLUDE_FILES.has(entry.name) || !ROOT_ALLOW.has(entry.name)) continue;
      }
      list.push({ abs, rel });
    }
  }
}

const files = [];
walk(ROOT, '', files);
// scripts 目录整体被排除了，这里单独把 DSH 端预设安装脚本放行（运行时拉取 preset 到 ~/.dsh 用）
const setupDsh = path.join(ROOT, 'scripts', 'setup-dsh.mjs');
if (fs.existsSync(setupDsh)) files.push({ abs: setupDsh, rel: 'scripts/setup-dsh.mjs' });
console.log(`[make-release-zip] 打包 ${files.length} 个文件（tag=${tag}）`);

// 输出目录必须存在，否则 createWriteStream 异步抛 ENOENT 崩溃
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const zip = new yazl.ZipFile();
for (const { abs, rel } of files) zip.addFile(abs, rel.replace(/\\/g, '/'));
const stream = zip.outputStream;
const dest = fs.createWriteStream(out);
let failed = false;
stream.on('error', (e) => { failed = true; console.error('[make-release-zip] 失败:', e.message); process.exit(1); });
dest.on('error', (e) => { failed = true; console.error('[make-release-zip] 写文件失败:', e.message); process.exit(1); });
stream.pipe(dest);
zip.end();
// 等 dest 写流真正完成（close/finish）再退出，避免尾部未刷盘导致截断 zip
dest.on('close', () => {
  if (failed) return;
  const size = fs.statSync(out).size;
  console.log(`[make-release-zip] ✅ ${out}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  process.exit(0);
});
