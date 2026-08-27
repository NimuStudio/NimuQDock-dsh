#!/usr/bin/env node
// setup-dsh.mjs — 把 NimuQDock-dsh 的 DSH 端配置安装到目标 DSH 环境。
//
// 做的事：
//   1. 复制两套 agent preset（qq-chat / qq-agent）到 ~/.dsh/.agent-presets/
//   2. 在 DSH profile 的 cordis.patch.yml 挂载两个 MCP server：
//      mcp-napcat（QQ 安全工具）/ mcp-web-search-safe（只读联网搜索）
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

const MCP_SERVERS = {
  'mcp-napcat': {
    script: path.join(REPO, 'src', 'mcp', 'qq-mcp.js'),
    toolTimeoutMs: 725000, // QQ 发送类动作可能耗时较长
  },
  'mcp-web-search-safe': {
    script: path.join(REPO, 'src', 'mcp', 'web-search-mcp.js'),
    toolTimeoutMs: null,
  },
};

const log = (msg) => console.log(`[setup-dsh] ${msg}`);
const fatal = (msg) => {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
};
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const yamlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// 1) agent preset
function installPresets() {
  for (const name of ['qq-chat', 'qq-agent']) {
    const src = path.join(REPO, 'dsh', 'agent-presets', name);
    if (!fs.existsSync(src)) fatal(`preset 不存在: ${src}`);
    ensureDir(path.join(DSH_HOME, '.agent-presets'));
    fs.cpSync(src, path.join(DSH_HOME, '.agent-presets', name), { recursive: true, force: true });
    log(`preset 已安装: ${name}`);
  }
}

// 2) cordis.patch.yml 挂载 MCP（用标记块包裹，便于重复运行替换）
function renderMcpBlock() {
  const lines = ['# === napcat-bridge MCP BEGIN ==='];
  for (const [id, cfg] of Object.entries(MCP_SERVERS)) {
    lines.push('- insert:');
    lines.push(`    - id: ${id}`);
    lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
    lines.push(`      config:`);
    lines.push(`        serverName: ${id.replace('mcp-', '')}`);
    lines.push('        transport: stdio');
    lines.push(`        command: ${yamlQuote(process.execPath)}`);
    lines.push('        args:');
    lines.push(`          - ${yamlQuote(cfg.script)}`);
    if (cfg.toolTimeoutMs) lines.push(`        toolCallTimeoutMs: ${cfg.toolTimeoutMs}`);
  }
  lines.push('# === napcat-bridge MCP END ===');
  return lines.join('\n');
}

function patchCordis() {
  ensureDir(PROFILE_DIR);
  const patchFile = path.join(PROFILE_DIR, 'cordis.patch.yml');
  const BEGIN = '# === napcat-bridge MCP BEGIN ===';
  const END = '# === napcat-bridge MCP END ===';
  const block = renderMcpBlock();
  let text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  if (text.includes(BEGIN) && text.includes(END)) {
    text = text.replace(/[^\n]*# === napcat-bridge MCP BEGIN ===[\s\S]*?# === napcat-bridge MCP END ===[^\n]*/, block.trimEnd());
    log('cordis.patch.yml：MCP 块已更新');
  } else if (text.includes('mcp-napcat') || text.includes('qq-mcp.js')) {
    log('cordis.patch.yml 已包含 mcp-napcat 条目，跳过（请人工核对路径是否指向本仓库）');
  } else {
    // 剥掉 DSH 模板自带、独立成行的空数组 `[]`，避免与追加块组成多个 YAML 根节点
    text = text.replace(/^[ \t]*\[\][ \t]*(?:\r?\n|$)/gm, '');
    const sep = text.trim() ? (text.endsWith('\n') ? '' : '\n') + '\n' : '';
    text += `${sep}${block}`;
    log('cordis.patch.yml：MCP 块已追加');
  }
  fs.writeFileSync(patchFile, text, 'utf8');
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
