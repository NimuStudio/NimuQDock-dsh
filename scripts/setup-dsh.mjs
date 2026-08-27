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

// 2) cordis.patch.yml：MCP 已下沉到 preset 的 agent 作用域（安全边界随 agent 走，
//    非 qq preset 不可见 QQ 工具）。此处仅负责**移除旧版 profile 级 MCP 块**（若存在）。
function patchCordis() {
  ensureDir(PROFILE_DIR);
  const patchFile = path.join(PROFILE_DIR, 'cordis.patch.yml');
  const BEGIN = '# === napcat-bridge MCP BEGIN ===';
  const END = '# === napcat-bridge MCP END ===';
  if (!fs.existsSync(patchFile)) return;
  let text = fs.readFileSync(patchFile, 'utf8');
  if (text.includes(BEGIN) && text.includes(END)) {
    text = text.replace(/[^\n]*# === napcat-bridge MCP BEGIN ===[\s\S]*?# === napcat-bridge MCP END ===[^\n]*/, '').trimEnd() + '\n';
    fs.writeFileSync(patchFile, text, 'utf8');
    log('cordis.patch.yml：旧版 profile 级 MCP 块已移除（MCP 现已挂载在 preset agent 作用域）');
  }
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
      fs.symlinkSync(repoPlugin, linkPath, 'junction'); // Windows 优先 junction
      log(`插件已链接: ${linkPath}`);
    } catch {
      fs.cpSync(repoPlugin, linkPath, { recursive: true, force: true });
      log('插件已复制（符号链接不可用）');
    }
  }

  // profile package.json 注册 bundle
  const pkgFile = path.join(PROFILE_DIR, 'package.json');
  ensureDir(PROFILE_DIR);
  let pkg = {};
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (error) {
      fatal(`profile package.json 解析失败: ${error?.message}`);
    }
  }
  const bundles = Array.isArray(pkg.dsh?.bundles) ? pkg.dsh.bundles : [];
  if (bundles.includes('qq-mode-console')) {
    log('profile bundle 已注册');
  } else {
    pkg.dsh = pkg.dsh ?? {};
    pkg.dsh.bundles = [...bundles, 'qq-mode-console'];
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    log('profile bundle 已注册: qq-mode-console');
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

// 5) dsh CLI 安装 bundle 依赖
function tryInstallBundleDeps() {
  try {
    const which = spawnSync('where', ['dsh'], { encoding: 'utf8' });
    if (which.status !== 0) {
      log('dsh CLI 不在 PATH，跳过自动安装（DSH 提示缺失依赖时手动执行 `dsh plugin --profile <profile> install`）');
      return;
    }
    const res = spawnSync('dsh', ['plugin', '--profile', PROFILE, 'install'], { encoding: 'utf8', timeout: 120000 });
    log(`dsh plugin install 退出码 ${res.status}${res.status !== 0 ? `（${(res.stderr || res.stdout || '').trim().slice(0, 200)}）` : ''}`);
  } catch (error) {
    log(`dsh plugin install 失败: ${error?.message ?? error}`);
  }
}

log(`DSH_HOME=${DSH_HOME} profile=${PROFILE}`);
installPresets();
patchCordis();
installPlugin();
writeModeFallback();
tryInstallBundleDeps();
log('完成。请重启 DSH 使 preset / MCP / 插件生效。');
log('验证：DSH 设置页应出现「napcat-mode」卡片；preset 列表应含「QQ 聊天角色（NapCat）」与「QQ 仿真群友（NapCat agent 模式）」。');
