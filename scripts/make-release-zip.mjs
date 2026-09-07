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
const EXCLUDE_DIRS = new Set([
  '.git', '.github', 'state', 'dist', 'node_modules/.cache',
  'docs',            // 说明文档（README 保留一份即可）
  'assets', 'tests',
  'scripts',         // 构建脚本整个排除；scripts/setup-dsh.mjs 走下方白名单放行
]);
const EXCLUDE_FILES = new Set(['config.json']);
const EXCLUDE_EXT = new Set(['.log', '.tmp']);
// 根目录可用文件白名单：只保留运行/安装/维护必需
const ROOT_ALLOW = new Set([
  'package.json', 'package-lock.json', 'config.example.json',
  'README.md', 'README.en.md', 'LICENSE',
  'install.bat', 'install.mjs', 'uninstall.bat', 'uninstall.mjs',
  'start.bat', 'restart.bat',
]);

function walk(dir, base, list) {
  const relDir = base || '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(abs, rel, list);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (EXCLUDE_FILES.has(entry.name) || EXCLUDE_EXT.has(ext)) continue;
      if (!relDir) {
        // 根目录文件只放行白名单
        if (!ROOT_ALLOW.has(entry.name)) continue;
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
