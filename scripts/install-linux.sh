#!/usr/bin/env bash
# NimuQDock-dsh · Ubuntu/Debian 一键部署脚本
#
# 做的事：检查并（可选）安装 Docker / Node 22 → 用 Docker 跑 NapCat → 问你管理员QQ/机器人QQ/API Key
#         → 写 OneBot 与项目配置 → 装 DSH 与预设 → 装 systemd 服务并启动。
#
# 用法（在项目目录里）：
#   sudo bash scripts/install-linux.sh
#
# 脚本可重复运行（幂等）；已存在的 NapCat 容器不会重复创建，config.json 会按你的输入重新生成。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_VERSION="0.1.1-rc.2"
NAPCAT_IMAGE="mlikiowa/napcat-docker:latest"
NAPCAT_DIR="/opt/napcat"
NPM_MIRROR="https://registry.npmmirror.com"
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "${RUN_HOME:-}" ] || RUN_HOME="$HOME"

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then IS_ROOT=1; fi
if [ "$IS_ROOT" -eq 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "需要 root 或 sudo 权限运行本脚本"
fi
# 以 root 运行 → 不加 sudo；否则加 sudo
SUDO=""
if [ "$IS_ROOT" -eq 0 ]; then SUDO="sudo"; fi
# docker 一律经此调用：root 直接跑，非 root 走 sudo（避免未加入 docker 组时权限不足）
dk() { if [ "$IS_ROOT" -eq 1 ]; then docker "$@"; else sudo docker "$@"; fi; }
as_root() { if [ "$IS_ROOT" -eq 1 ]; then "$@"; else sudo "$@"; fi; }

ask() { # ask <提示> [默认值]
  local p="$1" d="${2:-}" a
  if [ -n "$d" ]; then read -r -p "$p（回车=$d）：" a; else read -r -p "$p：" a; fi
  printf '%s' "${a:-$d}"
}
ask_secret() { local p="$1" a; read -r -s -p "$p：" a; echo >&2; printf '%s' "$a"; }
ask_qq() { # ask_qq <提示>：校验 5~12 位数字，返回号
  local p="$1" v
  while :; do
    v="$(ask "$p")"
    if [[ "$v" =~ ^[0-9]{5,12}$ ]]; then printf '%s' "$v"; return 0; fi
    warn "QQ 号应为 5~12 位数字，请重试。"
  done
}

# 非交互模式：设置环境变量即可无人值守部署（适合远程/脚本调用）
#   NQD_ADMIN_QQ=123 NQD_BOT_QQ=456 NQD_API_KEY=sk-xxx [NQD_GROUPS=111,222] [NQD_YES=1] bash scripts/install-linux.sh
ENV_ADMIN="${NQD_ADMIN_QQ:-}"
ENV_BOT="${NQD_BOT_QQ:-}"
ENV_KEY="${NQD_API_KEY:-}"
ENV_GROUPS="${NQD_GROUPS:-}"
AUTO_YES="${NQD_YES:-0}"
yes_no() { # yes_no <提示> <默认 y/n>：非交互模式直接返回默认
  local p="$1" d="${2:-y}"
  if [ "$AUTO_YES" = "1" ]; then printf '%s' "$d"; return 0; fi
  ask "$p" "$d"
}
input_qq() { # input_qq <提示> <环境变量值>
  local p="$1" v="$2"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  ask_qq "$p"
}

echo "────────────────────────────────────────────────────"
echo "  🔌 NimuQDock-dsh · Linux 一键部署（Ubuntu/Debian）"
echo "────────────────────────────────────────────────────"
echo "  项目目录: $ROOT"
echo "  运行用户: $RUN_USER"
echo

# ── [1/8] 依赖：Docker + Node ────────────────────────────────────────────────
say "[1/8] 检查 Docker 与 Node.js …"

if ! command -v docker >/dev/null 2>&1; then
  warn "未检测到 Docker。"
  if [ "$(yes_no '是否现在自动安装 Docker？(y/n)' y)" = "y" ]; then
    curl -fsSL https://get.docker.com | as_root sh
    ok "Docker 已安装"
  else
    die "请先安装 Docker 后重试：https://docs.docker.com/engine/install/ubuntu/"
  fi
fi
ok "Docker: $(dk -v 2>/dev/null | head -n1)"

NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${major:-0}" -ge 22 ]; then NEED_NODE=0; ok "Node: $(node -v)"; fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  warn "未检测到 Node.js ≥22（本项目需要）。"
  if [ "$(yes_no '是否现在自动安装 Node.js 22？(y/n)' y)" != "y" ]; then
    die "请先安装 Node.js ≥22.13 后重试：https://nodejs.org"
  fi
  if [ "$IS_ROOT" -eq 1 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  fi
  as_root apt-get install -y nodejs
  ok "Node: $(node -v)"
fi

# ── [2/8] 收集信息 ──────────────────────────────────────────────────────────
say "[2/8] 填写信息"
ADMIN_QQ="$(input_qq '① 你的QQ号（管理员/你自己）' "$ENV_ADMIN")"
BOT_QQ="$(input_qq '② 机器人的QQ号（扫码登录用）' "$ENV_BOT")"
API_KEY="$ENV_KEY"
while [ -z "$API_KEY" ]; do
  API_KEY="$(ask_secret '③ DeepSeek API Key（sk-...，用于机器人回话）')"
  [ -n "$API_KEY" ] || warn "不能为空。"
done
if [ -n "$ENV_GROUPS" ]; then
  GROUPS_RAW="$ENV_GROUPS"
else
  GROUPS_RAW="$(ask '④ 允许响应的QQ群号（多个用逗号分隔，不需要就留空）' '')"
fi

# ── [3/8] NapCat（Docker） ──────────────────────────────────────────────────
say "[3/8] 启动 NapCat（Docker）…"
as_root mkdir -p "$NAPCAT_DIR/config" "$NAPCAT_DIR/qq" "$NAPCAT_DIR/plugins"
as_root chown -R "$(id -u "$RUN_USER"):$(id -g "$RUN_USER")" "$NAPCAT_DIR"

if dk ps -a --format '{{.Names}}' | grep -qx napcat; then
  ok "已存在 napcat 容器，直接启动"
  dk start napcat >/dev/null
else
  dk run -d --name napcat --restart=always \
    -e NAPCAT_UID="$(id -u "$RUN_USER")" -e NAPCAT_GID="$(id -g "$RUN_USER")" \
    -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:6099:6099 \
    -v "$NAPCAT_DIR/config:/app/napcat/config" \
    -v "$NAPCAT_DIR/qq:/app/.config/QQ" \
    -v "$NAPCAT_DIR/plugins:/app/napcat/plugins" \
    "$NAPCAT_IMAGE" >/dev/null
  ok "napcat 容器已创建并启动"
fi

# OneBot 配置（HTTP 3000 + WS 3001），文件名必须与登录的机器人 QQ 一致
cat > "$NAPCAT_DIR/config/onebot11_${BOT_QQ}.json" <<JSON
{
  "network": {
    "httpServers": [
      { "enable": true, "name": "HTTP", "host": "127.0.0.1", "port": 3000, "enableCors": true, "enableWebsocket": false, "messagePostFormat": "array", "token": "", "debug": false }
    ],
    "httpSseServers": [], "httpClients": [],
    "websocketServers": [
      { "enable": true, "name": "WebSocket", "host": "127.0.0.1", "port": 3001, "reportSelfMessage": false, "enableForcePushEvent": true, "messagePostFormat": "array", "token": "", "debug": false, "heartInterval": 30000 }
    ],
    "websocketClients": [], "plugins": []
  },
  "musicSignUrl": "", "enableLocalFile2Url": false, "parseMultMsg": false, "imageDownloadProxy": "",
  "timeout": { "baseTimeout": 10000, "uploadSpeedKBps": 256, "downloadSpeedKBps": 256, "maxTimeout": 1800000 }
}
JSON
ok "已写入 OneBot 配置 onebot11_${BOT_QQ}.json"
dk restart napcat >/dev/null

# ── [4/8] 项目依赖 ──────────────────────────────────────────────────────────
say "[4/8] 安装项目依赖（npm ci）…"
cd "$ROOT"
if [ -d node_modules ] && [ -d node_modules/yaml ]; then
  ok "项目依赖已存在（跳过）"
else
  npm ci --registry="$NPM_MIRROR" || npm ci
  ok "项目依赖已安装"
fi

# ── [5/8] DSH ───────────────────────────────────────────────────────────────
say "[5/8] 安装 DeepSeek Harness 到 dsh-app/ …"
DSH_BIN="$ROOT/dsh-app/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -f "$DSH_BIN" ]; then
  mkdir -p "$ROOT/dsh-app"
  npm install --prefix "$ROOT/dsh-app" --no-save --no-package-lock \
    --registry="$NPM_MIRROR" "@deepseek-ai/dsh@${DSH_VERSION}" \
    || npm install --prefix "$ROOT/dsh-app" --no-save --no-package-lock "@deepseek-ai/dsh@${DSH_VERSION}"
fi
[ -f "$DSH_BIN" ] || die "DSH 安装失败，请检查网络后重试。"
ok "DSH 已安装"

# API Key（DSH_HOME=~/.dsh）
DSH_HOME="$RUN_HOME/.dsh"
mkdir -p "$DSH_HOME"
cat > "$DSH_HOME/.credentials.yaml" <<YAML
version: 1
refs:
  DEEPSEEK_API_KEY: ${API_KEY}
YAML
chmod 600 "$DSH_HOME/.credentials.yaml"
ok "API Key 已写入 $DSH_HOME/.credentials.yaml"

say "      安装 DSH 预设/插件（setup-dsh）…"
DSH_HOME="$DSH_HOME" node "$ROOT/scripts/setup-dsh.mjs" || warn "setup-dsh 有告警，可稍后手动重跑"

# ── [6/8] config.json ───────────────────────────────────────────────────────
say "[6/8] 生成 config.json …"
[ -f "$ROOT/config.example.json" ] || die "缺少 config.example.json"
cp -f "$ROOT/config.example.json" "$ROOT/config.json"
GROUPS_JSON="$(printf '%s' "$GROUPS_RAW" | tr ',' '\n' | tr -d '[:space:]' | grep -E '^[0-9]+$' | paste -sd, - || true)"
node - "$ROOT/config.json" "$ADMIN_QQ" "$GROUPS_JSON" <<'NODE'
const fs = require('node:fs');
const [file, admin, groups] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
c.ownerQQ = admin;
c.allow = c.allow || {};
c.allow.private = [admin];
c.allow.groups = groups ? groups.split(',') : [];
c.allowAllWhenEmpty = false;
c.napcat = { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: '' };
c.dsh = Object.assign({}, c.dsh, { baseUrl: 'http://127.0.0.1:3080', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' });
c.console = Object.assign({}, c.console, { port: 3100, autoOpen: false });
fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
NODE
ok "config.json 已生成（ownerQQ=$ADMIN_QQ，群白名单：${GROUPS_JSON:-无}）"

# ── [7/8] systemd 服务 ──────────────────────────────────────────────────────
say "[7/8] 配置开机自启（systemd）…"
NODE_BIN="$(command -v node)"
as_root tee /etc/systemd/system/dsh.service >/dev/null <<UNIT
[Unit]
Description=DeepSeek Harness (web)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${ROOT}
Environment=DSH_HOME=${DSH_HOME}
ExecStart=${NODE_BIN} ${DSH_BIN} web --port 3080 --host 127.0.0.1 --no-open
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

as_root tee /etc/systemd/system/nimuqdock.service >/dev/null <<UNIT
[Unit]
Description=NimuQDock-dsh bridge
After=network.target dsh.service
Wants=dsh.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${ROOT}
ExecStart=${NODE_BIN} ${ROOT}/src/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

as_root systemctl daemon-reload
as_root systemctl enable dsh.service >/dev/null 2>&1 || true
as_root systemctl restart dsh.service
ok "DSH 服务已启动"

# ── [8/8] 启动桥接 + 自检 ───────────────────────────────────────────────────
say "[8/8] 启动桥接并自检 …"
as_root systemctl enable nimuqdock.service >/dev/null 2>&1 || true
as_root systemctl restart nimuqdock.service
sleep 3

echo
say "自检："
if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3080/ ; then ok "DSH(3080) 可访问"; else warn "DSH(3080) 暂不可访问，看 journalctl -u dsh -f"; fi
LOGIN="$(curl -fsS --max-time 5 http://127.0.0.1:3000/get_login_info 2>/dev/null || true)"
if printf '%s' "$LOGIN" | grep -q '"status":"ok"'; then
  ok "NapCat 已登录：$LOGIN"
else
  warn "NapCat 还没登录机器人 QQ（正常，先扫码）"
fi
if ss -ltn 2>/dev/null | grep -q ':3100'; then ok "桥接控制台(3100) 已监听"; else warn "控制台未监听，看 journalctl -u nimuqdock -f"; fi

echo
echo "────────────────────────────────────────────────────"
ok "部署完成！还差最后一步：扫码登录机器人 QQ"
echo "────────────────────────────────────────────────────"
echo "  查看 NapCat WebUI Token（在本机执行）："
echo "      docker logs napcat | grep -i token"
echo
echo "  在你自己的电脑上用 SSH 隧道打开 WebUI / 控制台："
echo "      ssh -L 6099:127.0.0.1:6099 -L 3100:127.0.0.1:3100 ${RUN_USER}@<服务器IP>"
echo "        http://127.0.0.1:6099/webui   → 手机 QQ 扫码登录机器人账号"
echo "        http://127.0.0.1:3100         → Web 控制台"
echo
echo "  常用命令："
echo "      sudo systemctl status nimuqdock     # 桥接状态"
echo "      journalctl -u nimuqdock -f          # 桥接日志"
echo "      journalctl -u dsh -f                # DSH 日志"
echo "      docker logs -f napcat               # NapCat 日志"
echo "      sudo systemctl restart nimuqdock    # 改配置后重启桥接"
echo
warn "提示：云服务器 IP 登录 QQ 可能触发腾讯风控（掉线/要求重扫），家宽或稳定 IP 更稳。"
