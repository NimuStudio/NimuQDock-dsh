# 在 Ubuntu 服务器上部署 NimuQDock-dsh

把 QQ ↔ DeepSeek Harness 对接坞跑在 Linux 服务器上：**NapCat 用 Docker 跑 QQ，桥接与 DSH 用 Node 直接跑**。

## 一键部署（推荐）

```bash
git clone https://github.com/NimuStudio/NimuQDock-dsh.git
cd NimuQDock-dsh
sudo bash scripts/install-linux.sh
```

脚本会自动：检查/安装 Docker 与 Node 22 → 起 NapCat 容器 → 问你的**管理员QQ / 机器人QQ / DeepSeek API Key /（可选）群白名单** → 写 OneBot 与项目配置 → 装 DSH 与预设 → 装 systemd 服务并启动 → 自检。
跑完后按提示做 SSH 隧道、在 NapCat WebUI 扫码即可。

> 想手动一步步来 / 排障，见下面的分步说明。
>
> **无人值守（脚本调用/远程执行）**：用环境变量传入，跳过所有交互：
> ```bash
> NQD_ADMIN_QQ=你的QQ NQD_BOT_QQ=机器人QQ NQD_API_KEY=sk-xxx NQD_GROUPS=群号1,群号2 NQD_YES=1 \
>   sudo -E bash scripts/install-linux.sh
> ```

---

## 架构

```
QQ 用户 ── 腾讯服务器 ──> NapCat(Docker, 登录机器人QQ)  ── OneBot v11 ──> 桥接(node src/main.js) ──> DSH(dsh web)
                                  :3000(HTTP) :3001(WS)                       :3100(控制台)            :3080
```

三件套都在本机（127.0.0.1）互联，外网只需 QQ 自己连腾讯。

## 前置条件

- Ubuntu 20.04+，有 sudo
- 已装 Docker（`docker -v` 有输出）。没装：
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER   # 重新登录后免 sudo
  ```
- Node.js ≥ 22.13（桥接和 DSH 都要）：
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node -v   # 应 ≥ v22.13
  ```

> 国内服务器网络慢的话，给 npm 配镜像：`npm config set registry https://registry.npmmirror.com`

---

## 第 1 步：用 Docker 跑 NapCat（QQ）

```bash
sudo mkdir -p /opt/napcat/config /opt/napcat/qq /opt/napcat/plugins

sudo docker run -d --name napcat --restart=always \
  -e NAPCAT_UID=$(id -u) -e NAPCAT_GID=$(id -g) \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/qq:/app/.config/QQ \
  -v /opt/napcat/plugins:/app/napcat/plugins \
  mlikiowa/napcat-docker:latest
```

> 端口都绑到 `127.0.0.1`（只本机可访问，安全）。若你确实要远程看 WebUI，见文末"远程访问"。

**扫码登录机器人 QQ**：

```bash
sudo docker logs -f napcat
```

- 日志里会打印 **WebUi Token** 和地址 `http://127.0.0.1:6099/webui?token=xxxx`。
- 因为绑了 127.0.0.1，直接开不了——临时用 SSH 隧道在本机浏览器访问（见文末），或在服务器上换成本机 `curl`/端口转发。
- 打开 WebUI → 用**机器人 QQ 的手机 QQ** 扫码登录。
- 登录态会持久化在 `/opt/napcat/qq`，以后重启不用再扫。

**配置 OneBot 网络（HTTP 3000 + WS 3001）**：

写 `onebot11_<机器人QQ>.json`（把 `<机器人QQ>` 换成号）：

```bash
cat > /opt/napcat/config/onebot11_<机器人QQ>.json <<'JSON'
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

sudo docker restart napcat
```

验证 OneBot 起来了：

```bash
curl -s http://127.0.0.1:3000/get_login_info
# 看到 {"status":"ok",...} 且 QQ 号正确即 OK
```

---

## 第 2 步：拉项目 + 装依赖

```bash
cd ~
git clone https://github.com/NimuStudio/NimuQDock-dsh.git
cd NimuQDock-dsh
npm ci
```

---

## 第 3 步：装并启动 DSH（DeepSeek Harness）

```bash
# 装到独立目录 dsh-app（不污染项目依赖）
npm install --prefix dsh-app --no-save --no-package-lock @deepseek-ai/dsh@0.1.1-rc.2

# 填 API Key（换成你自己的 sk-...）
mkdir -p ~/.dsh
cat > ~/.dsh/.credentials.yaml <<'YAML'
version: 1
refs:
  DEEPSEEK_API_KEY: sk-你的key
YAML

# 装预设/插件到 ~/.dsh
node scripts/setup-dsh.mjs
```

启动 DSH（前台先试跑）：

```bash
node dsh-app/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080 --host 127.0.0.1 --no-open
```

另开一个终端确认：

```bash
curl -s http://127.0.0.1:3080/ -o /dev/null -w '%{http_code}\n'   # 200 即 OK
```

---

## 第 4 步：写 config.json

```bash
cp config.example.json config.json
```

编辑 `config.json`，至少改这几处：

```json
{
  "ownerQQ": "你的QQ号",
  "allow": { "private": ["你的QQ号"], "groups": ["允许的群号"] },
  "console": { "port": 3100, "token": "", "autoOpen": false },
  "dsh": { "baseUrl": "http://127.0.0.1:3080", "model": "deepseek-v4-flash-vision-exp" },
  "napcat": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "" }
}
```

> 服务器没图形界面，把 `console.autoOpen` 设为 `false`。
> `allow.groups` 空数组 = 不响应任何群；只私聊你就留空数组。

---

## 第 5 步：启动桥接

```bash
node src/main.js
```

看到日志里有连接成功的字样即可；控制台在 `http://127.0.0.1:3100`（同样走 SSH 隧道访问）。

---

## 第 6 步：做成开机自启（systemd）

NapCat 已带 `--restart=always`，Docker 起来它自动起。DSH 和桥接各写一个 service：

`/etc/systemd/system/dsh.service`：

```ini
[Unit]
Description=DeepSeek Harness (web)
After=network.target

[Service]
Type=simple
User=你的用户名
WorkingDirectory=/home/你的用户名/NimuQDock-dsh
Environment=DSH_HOME=/home/你的用户名/.dsh
ExecStart=/usr/bin/node /home/你的用户名/NimuQDock-dsh/dsh-app/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080 --host 127.0.0.1 --no-open
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/nimuqdock.service`：

```ini
[Unit]
Description=NimuQDock-dsh bridge
After=network.target dsh.service
Wants=dsh.service

[Service]
Type=simple
User=你的用户名
WorkingDirectory=/home/你的用户名/NimuQDock-dsh
ExecStart=/usr/bin/node /home/你的用户名/NimuQDock-dsh/src/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh nimuqdock
sudo systemctl status nimuqdock
journalctl -u nimuqdock -f      # 看桥接日志
```

以后改代码后重启：`sudo systemctl restart nimuqdock`（改预设后也要 `sudo systemctl restart dsh`）。

---

## 远程访问控制台 / NapCat WebUI（可选）

它们在 127.0.0.1，最安全的做法是 **SSH 隧道**（在你自己的电脑上执行）：

```bash
ssh -L 3100:127.0.0.1:3100 -L 6099:127.0.0.1:6099 你的用户@服务器IP
```

然后本地浏览器开 `http://127.0.0.1:3100`（控制台）、`http://127.0.0.1:6099/webui`（NapCat）。

**不要**把 3100/6099 直接暴露公网；确实需要就上 Nginx + HTTPS + 鉴权。

---

## 注意事项（重要）

1. **QQ 风控**：机房/云服务器 IP 登录 QQ，腾讯容易判"环境异常"→ 掉线、要求重新扫码，严重会冻结。**家宽/稳定 IP 最稳**。这是所有 QQ 机器人在服务器上的通病，不是本项目的问题。
2. **换号/换机器**：`/opt/napcat/qq` 目录是登录态，迁移机器时一起拷过去可免重新扫码。
3. **NapCat 版本**：`mlikiowa/napcat-docker:latest` 会自动更新；若某次更新后登录异常，可回退指定 tag。
4. **磁盘**：QQ 群多、图多时 `/opt/napcat/qq` 会长大，定期清理 NapCat 缓存。
5. **API Key 安全**：`~/.dsh/.credentials.yaml` 含明文 key，注意文件权限（`chmod 600`）。
6. **`console.token`**：如果哪天要暴露控制台，务必设置非空 token。

---

## 常见问题

- **`get_login_info` 返回失败 / 3000 不通**：NapCat 还没登录，或 `onebot11_<QQ>.json` 文件名里的 QQ 号与登录的号不一致。
- **桥接连不上 NapCat**：确认 NapCat 容器在跑（`sudo docker ps`）、3001 端口监听（`ss -ltnp | grep 3001`）。
- **机器人不回话**：看 `journalctl -u nimuqdock -f`；检查 `allow` 白名单、DSH 是否在跑、`~/.dsh/.credentials.yaml` 的 key 是否有效。
- **图片识别失效**：确认 `config.json` 的 `dsh.model` 是带 `vision` 的模型（`deepseek-v4-flash-vision-exp`），且 DSH 模型列表里有它。
