#!/usr/bin/env node
// setup-dsh.mjs — 把 NimuQDock-dsh 的 DSH 端配置安装到目标 DSH 环境。
//
// 做的事：
//   1. 复制两套 agent preset（qq-chat / qq-agent）到 ~/.dsh/.agent-presets/，
//      并把 MCP（mcp-napcat / mcp-web-search-safe）挂载在 preset 的 agent 作用域
//      （安全边界随 agent 走：非 qq preset 看不到 QQ 工具）
//   2. 移除旧版 profile 级 cordis.patch.yml MCP 块（若存在）
//   3. 在 profile package.json 注册 qq-mode-console 插件 bundle
//   4. 创建本地 state/mode.json 兜底（默认 chat，仅在不存在时写入）
//   5. 若 dsh CLI 可用，自动执行 `dsh plugin --profile <profile> install`
//
// 用法：node scripts/setup-dsh.mjs [profile]
// 环境变量：DSH_HOME 指定 DSH 根目录（默认 ~/.dsh）
// 幂等：可重复运行；移动过项目目录后必须重跑（MCP/插件路径是绝对路径）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);

const log = (msg) => console.log(`[setup-dsh] ${msg}`);
const fatal = (msg) => {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
};
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

// 1) agent preset（复制到 ~/.dsh/.agent-presets/，并注入 MCP 的绝对路径占位符）
function installPresets() {
  for (const name of ['qq-chat', 'qq-agent']) {
    const src = path.join(REPO, 'dsh', 'agent-presets', name);
    if (!fs.existsSync(src)) fatal(`preset 不存在: ${src}`);
    ensureDir(path.join(DSH_HOME, '.agent-presets'));
    fs.cpSync(src, path.join(DSH_HOME, '.agent-presets', name), { recursive: true, force: true });
    // MCP 由 DSH spawn：agent.cordis.yml 里的 __NODE__ / __REPO__ 替换为绝对路径
    const cordisFile = path.join(DSH_HOME, '.agent-presets', name, 'agent.cordis.yml');
    const text = fs.readFileSync(cordisFile, 'utf8')
      .replaceAll('__NODE__', process.execPath)
      .replaceAll('__REPO__', REPO);
    fs.writeFileSync(cordisFile, text, 'utf8');
    log(`preset 已安装: ${name}（MCP 路径已注入）`);
  }
}

// 2) cordis.patch.yml：
//    a. MCP 已下沉到 preset 的 agent 作用域（安全边界随 agent 走，非 qq preset 不可见 QQ 工具），
//       此处负责**移除旧版 profile 级 MCP 块**（若存在）。
//    b. 必须重新启用 hmr：dsh-web-app 的补丁把 hmr 设成 disabled: true，
//       而 dsh 启动时的 "user patch-layer watching" 又要求 hmr 服务，
//       两者冲突会让 web profile 直接报 "requires the Cordis HMR service" 起不来。
const HMR_PATCH_ENTRY = [
  '',
  '# dsh-web-app 的补丁禁用了 hmr，但 dsh 启动时需要它（user patch-layer watching）',
  '# → 在最后一层重新启用，否则 web profile 启动会失败',
  '- id: hmr',
  '  disabled: false',
  '',
].join('\n');

function ensureCordisPatch() {
  ensureDir(PROFILE_DIR);
  const patchFile = path.join(PROFILE_DIR, 'cordis.patch.yml');
  const BEGIN = '# === napcat-bridge MCP BEGIN ===';
  const END = '# === napcat-bridge MCP END ===';
  let text = '';
  try {
    if (fs.existsSync(patchFile)) text = fs.readFileSync(patchFile, 'utf8');
  } catch (error) {
    log(`cordis.patch.yml 读取失败：${error?.message ?? error}`);
  }
  if (text.includes(BEGIN) && text.includes(END)) {
    text = text.replace(/[^\n]*# === napcat-bridge MCP BEGIN ===[\s\S]*?# === napcat-bridge MCP END ===[^\n]*/, '').trimEnd() + '\n';
    log('cordis.patch.yml：旧版 profile 级 MCP 块已移除（MCP 现已挂载在 preset agent 作用域）');
  }
  if (/^[ \t]*-[ \t]*id:[ \t]*hmr\b/m.test(text)) {
    if (text) fs.writeFileSync(patchFile, text, 'utf8');
    log('cordis.patch.yml：hmr 已启用（跳过）');
    return;
  }
  // 去掉占位的空数组（`[]` 或 "# 注释\n[]"），再追加条目
  const body = text.replace(/\n?\s*\[\]\s*$/, '').trimEnd();
  const next = (body ? `${body}\n` : '') + HMR_PATCH_ENTRY;
  fs.writeFileSync(patchFile, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  log('cordis.patch.yml：已重新启用 hmr（否则 DSH 无法启动）');
}

// 3) profile 清单：DSH 初始化 profile 时若发现 package.json 已存在就不再补写
//    dsh.profile.bundles，因此必须在首次启动前把 web 默认 bundles 补齐；
//    否则 web app（含 hmr / 连接层）永远不会被加载。
const WEB_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

function ensureProfileManifest() {
  ensureDir(PROFILE_DIR);
  const pkgFile = path.join(PROFILE_DIR, 'package.json');
  let pkg = {};
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (error) {
      fatal(`profile package.json 解析失败: ${error?.message}`);
    }
  }
  let changed = false;
  if (!pkg.name) { pkg.name = 'dsh-profile-web'; changed = true; }
  if (pkg.private === undefined) { pkg.private = true; changed = true; }
  pkg.dsh = pkg.dsh ?? {};
  const profile = pkg.dsh.profile ?? {};
  const current = Array.isArray(profile.bundles) ? profile.bundles : [];
  const missing = WEB_PROFILE_BUNDLES.filter((b) => !current.includes(b));
  if (missing.length > 0) {
    profile.bundles = [...current, ...missing];
    pkg.dsh.profile = profile;
    changed = true;
  }
  const bundles = Array.isArray(pkg.dsh.bundles) ? pkg.dsh.bundles : [];
  if (!bundles.includes('qq-mode-console')) {
    pkg.dsh.bundles = [...bundles, 'qq-mode-console'];
    changed = true;
  }
  if (!changed) {
    log('profile 清单已完整（跳过）');
    return;
  }
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log(`profile 清单已更新（web bundles: ${(pkg.dsh.profile?.bundles ?? []).join(', ')}；插件: qq-mode-console）`);
}

// 3) 插件 bundle
function installPlugin() {
  const repoPlugin = path.join(REPO, 'plugins', 'qq-mode-console');
  if (!fs.existsSync(repoPlugin)) fatal(`插件不存在: ${repoPlugin}`);
  ensureDir(path.join(DSH_HOME, 'plugins'));
  const linkPath = path.join(DSH_HOME, 'plugins', 'qq-mode-console');
  let linked = false;
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(linkPath);
      if (target && path.resolve(path.dirname(linkPath), target) === repoPlugin) {
        linked = true;
      } else {
        fs.unlinkSync(linkPath);
      }
    } else {
      log('插件路径已存在且为真实目录，跳过链接（请人工核对）');
      return;
    }
  } catch {
    // 不存在 → 继续创建链接
  }
  if (!linked) {
    try {
      // Windows 用 junction（免管理员权限）；其它平台用目录符号链接
      fs.symlinkSync(repoPlugin, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      log(`插件已链接: ${linkPath}`);
    } catch {
      fs.cpSync(repoPlugin, linkPath, { recursive: true, force: true });
      log('插件已复制（符号链接不可用）');
    }
  }
}

// 4) 模式兜底文件
function writeModeFallback() {
  const modeFile = path.join(REPO, 'state', 'mode.json');
  if (fs.existsSync(modeFile)) {
    log('state/mode.json 已存在，保留用户设置');
    return;
  }
  ensureDir(path.dirname(modeFile));
  fs.writeFileSync(modeFile, JSON.stringify({ mode: 'chat' }, null, 2) + '\n', 'utf8');
  log('state/mode.json 已创建（mode: chat）');
}

// 5) dsh CLI 安装 bundle 依赖（可选步骤：profile 没有声明 dependencies 时本就无事可做）
function tryInstallBundleDeps() {
  // profile 只有 bundle 列表、没有 npm 依赖时，跳过这次外部调用（避免无谓的 dsh 启动开销）
  try {
    const pkgFile = path.join(PROFILE_DIR, 'package.json');
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const deps = Object.keys(pkg.dependencies ?? {});
      if (deps.length === 0) {
        log('profile 没有额外依赖，跳过 dsh plugin install');
        return;
      }
    }
  } catch {}
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' });
    if (which.status !== 0) {
      log('dsh CLI 不在 PATH，跳过自动安装（DSH 提示缺失依赖时手动执行 `dsh plugin --profile <profile> install`）');
      return;
    }
    // Windows 上 dsh 是 .cmd，必须经 shell 才能启动
    const res = spawnSync('dsh', ['plugin', '--profile', PROFILE, 'install'], { encoding: 'utf8', timeout: 120000, shell: process.platform === 'win32' });
    log(`dsh plugin install 退出码 ${res.status}${res.status !== 0 ? `（${(res.stderr || res.stdout || '').trim().slice(0, 200)}）` : ''}`);
  } catch (error) {
    log(`dsh plugin install 失败: ${error?.message ?? error}`);
  }
}

/**
 * DSH 0.2 的 bundle 从 **profile 的 node_modules** 解析（0.1 才看 <DSH_HOME>/plugins）。
 * 因此对已经是 pnpm 项目的 profile（有 node_modules 或 pnpm-workspace.yaml），
 * 把插件登记为 file: 依赖并安装一次；否则保持 0.1 的 junction 方案即可。
 */
function installProfileBundleDependency() {
  const pkgFile = path.join(PROFILE_DIR, 'package.json');
  const pluginDir = path.join(REPO, 'plugins', 'qq-mode-console');
  const looksLike02 = fs.existsSync(path.join(PROFILE_DIR, 'node_modules')) || fs.existsSync(path.join(PROFILE_DIR, 'pnpm-workspace.yaml'));
  if (!looksLike02) {
    log('profile 不是 pnpm 工程（DSH 0.1 风格）→ 跳过 profile 依赖安装');
    return;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.dependencies = pkg.dependencies ?? {};
    // link: 让 pnpm 建符号链接：插件源码更新后无需重装即生效（file: 会复制且不刷新）
    const spec = `link:${pluginDir.replace(/\\/g, '/')}`;
    let changed = false;
    if (pkg.dependencies['qq-mode-console'] !== spec) {
      pkg.dependencies['qq-mode-console'] = spec;
      changed = true;
      log('profile 依赖已登记: qq-mode-console → plugins/qq-mode-console');
    }
    // 关键：0.2 只加载 `dsh.profile.bundles` 里列出的 bundle（`dsh.bundles` 是 0.1 的写法）
    pkg.dsh = pkg.dsh ?? {};
    pkg.dsh.profile = pkg.dsh.profile ?? {};
    const profileBundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (!profileBundles.includes('qq-mode-console')) {
      pkg.dsh.profile.bundles = [...profileBundles, 'qq-mode-console'];
      changed = true;
      log('已把 qq-mode-console 加入 profile.bundles（0.2 的加载列表）');
    }
    if (changed) fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    else log('profile 依赖已登记（跳过）');
  } catch (error) {
    log(`登记 profile 依赖失败：${error?.message ?? error}`);
    return;
  }
  // 用仓库自带的 pnpm 工具（installer 会把 pnpm 装到 <repo>/pnpm-tool），否则退回 PATH
  const localPnpm = path.join(REPO, 'pnpm-tool', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  let cmd = null;
  let args = [];
  if (fs.existsSync(localPnpm)) {
    cmd = process.execPath;
    args = [localPnpm, 'install', '--dir', PROFILE_DIR, '--config.node-linker=hoisted'];
  } else {
    cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    args = ['install', '--dir', PROFILE_DIR, '--config.node-linker=hoisted'];
  }
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' && cmd !== process.execPath });
  if (res.status === 0) {
    log('profile 依赖已安装（qq-mode-console）');
  } else {
    log(`profile 依赖安装失败（码 ${res.status}）：${(res.stderr || res.stdout || '').trim().slice(0, 300)}`);
    log('可手动在 profile 目录执行 pnpm install');
  }
}

log(`DSH_HOME=${DSH_HOME} profile=${PROFILE}`);
installPresets();
ensureCordisPatch();
ensureProfileManifest();
installPlugin();
installProfileBundleDependency();
writeModeFallback();
tryInstallBundleDeps();
log('完成。请重启 DSH 使 preset / MCP / 插件生效。');
log('验证：DSH 设置页应出现「napcat-mode」卡片；preset 列表应含「QQ 聊天角色（NapCat）」与「QQ 仿真群友（NapCat agent 模式）」。');
