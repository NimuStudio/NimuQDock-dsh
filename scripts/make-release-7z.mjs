// 发布打包：生成 UTF-8 文件名的 7z（供 SFX exe 使用；SFX 只支持 7z 格式）。
// Windows 的 7za 默认把文件名按 ANSI(GBK) 写入，这里用 UTF-8 listfile + -scsUTF-8 强制 UTF-8。
// 用法: node scripts/make-release-7z.mjs <tag名> <输出.7z>
// 依赖: 7za 可执行（环境变量 7ZA 或 PATH 中的 7za/7z）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tag, out] = process.argv.slice(2);
if (!tag || !out) { console.error('usage: node scripts/make-release-7z.mjs <tag> <out.7z>'); process.exit(1); }

const SEVEN_ZA = process.env['7ZA'] || (process.platform === 'win32' ? '7za' : '7za');
const EXCLUDE_DIRS = new Set(['.git', 'state', '.github', 'node_modules/.cache']);
const EXCLUDE_FILES = new Set(['config.json']);
const EXCLUDE_EXT = new Set(['.log', '.tmp']);

function walk(dir, base, list) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(rel) || EXCLUDE_DIRS.has(entry.name)) continue;
      walk(abs, rel, list);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (EXCLUDE_FILES.has(entry.name) || EXCLUDE_EXT.has(ext)) continue;
      list.push(rel.split(path.sep).join('\\'));
    }
  }
}

const files = [];
walk(ROOT, '', files);
console.log(`[make-release-7z] ${files.length} 个文件（tag=${tag}）`);

// 临时 UTF-8 listfile
const listFile = path.join(os.tmpdir(), `nimuqdock-7zlist-${process.pid}.txt`);
fs.writeFileSync(listFile, files.join('\r\n'), 'utf8');

const args = ['a', '-t7z', '-scsUTF-8', '-mx5', out, '@' + listFile];
console.log(`[make-release-7z] 7za ${args.join(' ')}`);
const result = spawnSync(SEVEN_ZA, args, { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
try { fs.unlinkSync(listFile); } catch {}

if (result.status !== 0) {
  console.error('[make-release-7z] 失败:', (result.stderr || result.stdout || '').slice(-500));
  process.exit(1);
}
const size = fs.statSync(out).size;
console.log(`[make-release-7z] ✅ ${out}（${(size / 1024 / 1024).toFixed(1)} MB）`);
process.exit(0);
