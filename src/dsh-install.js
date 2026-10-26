// DSH 便携安装（install.mjs 与 start.mjs 共用）。
//
// 为什么不是 `npm install`：DSH 的依赖树 peer 声明极多，npm 的 peer 解析会长时间卡住
// （实测：20 分钟无进展、内存飙到 1GB+），而 `--legacy-peer-deps` 虽然快又会漏装 peer
// （实测缺 @deepseek-ai/cordis-plugin-group 导致启动即崩）。
// pnpm 解析同一棵树只需十几秒且依赖完整，因此改为「本地供给 pnpm → pnpm install」。
//
// 必须钉死 hmr 版本：DSH 0.1.x 的 dsh-app-boot 会调用 hmr 服务的 registerConfig()，
// 而 @deepseek-ai/cordis-plugin-hmr 自 1.0.18 起已没有这个方法（1.0.20 实测 0 命中）。
// 不钉版本时 pnpm/npm 都会解析到最新版 → DSH 启动直接报
//   "user patch-layer watching requires the Cordis HMR service"
// pnpm 11 不再读 package.json 的 pnpm 字段，overrides 必须写在 pnpm-workspace.yaml。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 项目锁定的 DSH 版本：与 package.json 里 dsh-host-apiproxy 同版本线，保证 API 兼容。 */
/** 项目锁定的 DSH 版本：桥接已适配 0.2.x（session/modelCatalog、session/follow、remote.mux）。 */
export const DSH_VERSION = '0.2.1-rc.2';
/** 0.1.x 需要这个 hmr 版本（含 registerConfig）；0.2.x 自带 @deepseek-ai/dsh-hmr，此项不生效。 */
export const HMR_VERSION = '1.0.17';
/** 本地供给 pnpm 用的版本（只装一次，缓存在 <root>/pnpm-tool）。 */
const PNPM_TOOL_VERSION = '11';
const MIRROR = 'https://registry.npmmirror.com';

const log = (msg) => console.log(msg);

/** 当前 node 自带的 npm-cli（便携版内置 node 的 PATH 里没有 npm）。 */
function resolveNpmCli() {
  return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** 从任意位置读 package.json 的 version 字段（读不到返回 null）。 */
function readPackageVersion(pkgDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** 收集 dsh-app 里所有 hmr 插件的实际版本（pnpm 可能装出多份）。 */
function collectHmrVersions(prefix) {
  const versions = new Set();
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'cordis-plugin-hmr') {
        const v = readPackageVersion(full);
        if (v) versions.add(v);
        continue;
      }
      if (entry.name === 'node_modules' || entry.name.startsWith('@') || dir.endsWith('node_modules')) {
        walk(full, depth + 1);
      }
    }
  };
  walk(prefix, 0);
  return [...versions];
}

/** 确保本地有 pnpm 可用，返回其入口文件路径；失败返回 null。 */
function ensurePnpmTool(root) {
  const toolDir = path.join(root, 'pnpm-tool');
  const entry = path.join(toolDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (fs.existsSync(entry)) return entry;

  log('⏳ 准备安装工具（pnpm，仅首次）…');
  try {
    fs.mkdirSync(toolDir, { recursive: true });
  } catch {}
  // 独立的 package.json，避免 npm 把项目自身的依赖树也纳入 reconcile
  try {
    fs.writeFileSync(path.join(toolDir, 'package.json'), JSON.stringify({ name: 'dsh-install-tool', private: true }, null, 2) + '\n', 'utf8');
  } catch {}

  const npmCli = resolveNpmCli();
  const args = ['install', `pnpm@${PNPM_TOOL_VERSION}`, '--no-audit', '--no-fund'];
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
  const run = (extra) => (fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args, ...extra], { cwd: toolDir, stdio: 'inherit', timeout: 600000, env })
    : spawnSync('npm', [...args, ...extra], { cwd: toolDir, stdio: 'inherit', shell: true, timeout: 600000, env }));

  let r = run([`--registry=${MIRROR}`]);
  if (r.status !== 0) r = run([]);
  if (r.status !== 0 || !fs.existsSync(entry)) {
    log('❌ 安装工具 pnpm 失败，请检查网络后重试。');
    return null;
  }
  return entry;
}

/**
 * 便携安装 DSH 到 prefix（默认 <root>/dsh-app）。
 * @param {{root: string, prefix: string, binPath: string, version?: string, hmrVersion?: string}} options
 * @returns {boolean} 是否安装成功且版本校验通过
 */
export function installDshPortable({ root, prefix, binPath, version = DSH_VERSION, hmrVersion = HMR_VERSION }) {
  log(`⏳ 正在便携安装 DeepSeek Harness（@deepseek-ai/dsh@${version}，首次需 1~2 分钟）…`);
  const pnpm = ensurePnpmTool(root);
  if (!pnpm) return false;

  try {
    fs.mkdirSync(prefix, { recursive: true });
  } catch {}

  // 1) 声明依赖
  try {
    fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({
      name: 'dsh-app',
      private: true,
      dependencies: { '@deepseek-ai/dsh': version },
    }, null, 2) + '\n', 'utf8');
  } catch (error) {
    log(`❌ 写入 dsh-app/package.json 失败：${error?.message ?? error}`);
    return false;
  }

  // 2) pnpm 设置：
  //    - 扁平布局：DSH 插件按包名解析，符号链接布局易踩坑
  //    - 钉死 hmr 版本（pnpm 11 只读 pnpm-workspace.yaml 里的 overrides）
  //    - storeDir 放在包内：卸载删目录即彻底干净，不往用户其它盘丢仓库
  //    - ignoredBuiltDependencies：这些包的原生构建脚本我们不需要（DSH 的 Web API 用不到），
  //      显式声明后 pnpm 不再以 ERR_PNPM_IGNORED_BUILDS 报错（否则退出码非 0 会被误判为失败）
  const workspaceYml = [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: true',
    'storeDir: .pnpm-store',
    '',
    'overrides:',
    `  '@deepseek-ai/cordis-plugin-hmr': ${hmrVersion}`,
    '',
    'ignoredBuiltDependencies:',
    '  - "@deepseek-ai/dsh-subprocess-local"',
    '  - "@google/genai"',
    '  - koffi',
    '  - node-pty',
    '  - protobufjs',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(path.join(prefix, 'pnpm-workspace.yaml'), workspaceYml, 'utf8');
  } catch (error) {
    log(`❌ 写入 pnpm-workspace.yaml 失败：${error?.message ?? error}`);
    return false;
  }

  // 3) 安装（镜像失败自动退回官方源）；成败以**产物校验**为准，不看退出码
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
  const run = (extra) => spawnSync(process.execPath, [pnpm, 'install', '--dir', prefix, ...extra], {
    cwd: prefix, stdio: 'inherit', timeout: 1500000, env,
  });
  const verify = () => {
    if (!fs.existsSync(binPath)) return { ok: false, reason: `未找到 DSH 入口（${binPath}）` };
    const versions = collectHmrVersions(prefix);
    if (versions.length > 0 && !versions.every((v) => v === hmrVersion)) {
      return { ok: false, reason: `hmr 插件版本不符（需要 ${hmrVersion}，实际 ${versions.join(', ')}）` };
    }
    return { ok: true, hmrVersions: versions };
  };

  log('   → 使用国内镜像源 npmmirror（更快更稳）…');
  run([`--registry=${MIRROR}`]);
  let check = verify();
  if (!check.ok) {
    log(`   校验未通过（${check.reason}），改用官方源重试一次…`);
    run([]);
    check = verify();
  }
  if (!check.ok) {
    log(`❌ 便携安装 DSH 失败：${check.reason}`);
    log('   请删除 dsh-app 目录后重试；若持续失败请检查网络。');
    return false;
  }
  log(`✅ DeepSeek Harness 已便携安装（dsh ${version} / hmr ${check.hmrVersions.join(',') || 'n/a'}）`);
  return true;
}

export { resolveNpmCli };
