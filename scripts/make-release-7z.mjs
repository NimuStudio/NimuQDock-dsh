// 发布打包：生成 UTF-8 文件名的 7z（供 SFX exe 使用；SFX 只支持 7z 格式）。
// Windows 的 7za 默认把文件名按 ANSI(GBK) 写入，这里用 UTF-8 listfile + -scsUTF-8 强制 UTF-8。
// 用法: node scripts/make-release-7z.mjs <tag名> <输出.7z>
// 依赖: 7za 可执行（环境变量 7ZA，或 PATH 中的 7za/7z）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tag, out] = process.argv.slice(2);
if (!tag || !out) { console.error('usage: node scripts/make-release-7z.mjs <tag> <out.7z>'); process.exit(1); }

/** 找到 7za/7z 可执行：环境变量 7ZA → PATH。 */
function find7za() {
  const env = process.env['7ZA'];
  if (env && fs.existsSync(env)) return env;
  const names = process.platform === 'win32' ? ['7za.exe', '7z.exe'] : ['7za', '7z'];
  for (const n of names) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const p = r.stdout.split('\n')[0].trim();
      if (p) return p;
    }
  }
  return null;
}

// ── 运行时最小包：只装「跑起来」需要的，开发/文档/发布脚本一律不进安装包 ──
const EXCLUDE_DIRS = new Set([
  '.git', '.github', 'state', 'dist', 'node_modules/.cache',
  'docs',            // 说明文档（README 保留一份即可）
  'assets', 'tests',
  'scripts',         // 构建脚本整个排除；scripts/setup-dsh.mjs 走下方白名单放行
]);
const EXCLUDE_FILES = new Set(['config.json', '.env', '.env.local', '.env.production']);
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
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(rel) || EXCLUDE_DIRS.has(entry.name)) continue;
      walk(abs, rel, list);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (EXCLUDE_FILES.has(entry.name) || EXCLUDE_EXT.has(ext)) continue;
      if (!relDir) {
        // 根目录文件只放行白名单
        if (!ROOT_ALLOW.has(entry.name)) continue;
      }
      // 统一用正斜杠（7z 跨平台规范路径）
      list.push(rel.split(path.sep).join('/'));
    }
  }
}

const sevenZa = find7za();
if (!sevenZa) {
  console.error('[make-release-7z] 未找到 7za。请安装 7-Zip 或设置环境变量 7ZA。');
  process.exit(1);
}

const files = [];
walk(ROOT, '', files);
// scripts 目录整体被排除了，这里单独把 DSH 端预设安装脚本放行（运行时拉取 preset 到 ~/.dsh 用）
const setupDsh = path.join(ROOT, 'scripts', 'setup-dsh.mjs');
if (fs.existsSync(setupDsh)) files.push('scripts/setup-dsh.mjs');
console.log(`[make-release-7z] ${files.length} 个文件（tag=${tag}，7za=${sevenZa}）`);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const listFile = path.join(os.tmpdir(), `nimuqdock-7zlist-${process.pid}.txt`);
try {
  fs.writeFileSync(listFile, files.join('\r\n'), 'utf8');
  // -y：覆盖已存在的输出，避免交互询问挂起 CI
  const args = ['a', '-t7z', '-scsUTF-8', '-mx5', '-y', out, '@' + listFile];
  console.log(`[make-release-7z] 7za ${args.join(' ')}`);
  const result = spawnSync(sevenZa, args, { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  if (result.status !== 0) {
    console.error('[make-release-7z] 失败:', (result.stderr || result.stdout || '').slice(-500));
    process.exit(1);
  }
  const size = fs.statSync(out).size;
  console.log(`[make-release-7z] ✅ ${out}（${(size / 1024 / 1024).toFixed(1)} MB）`);
} finally {
  try { fs.unlinkSync(listFile); } catch {}
}
process.exit(0);
