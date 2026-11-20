# TeleAgent + TA2API 的 Linux / NAS Docker 部署指南（自给自足版）

> 本文按 **2026-11-21 版 TA2API 代码**（三协议工具中继 + 逐字流式 + 看门狗 + 自管凭据库 +
> 管理台登录）和 **TeleAgent 3.1.1 官方 Linux deb 实测**编写，不是照抄 `docs/nas-docker.md`
> （那份是 v0.7.x 的设计稿，其中多数能力当时不存在）。
>
> **结论先行（含一条重要限制）**：
> - 容器能完整跑起内核：三协议、工具中继闭环、看门狗自愈、局域网访问、管理台、卷持久化
>   均已实测通过（第 7 节）。
> - **首次取得凭据**：浏览器完成官方登录后，从 Cookie 里取 `operationToken` 粘进管理台即可
>   （它形如 `<租户>:<accessToken>`，冒号后段就是 access token），详见 2.2。
> - **⚠ 自动续期在容器内不可行**（2026-11-21 实测）：服务端只接受官方桌面客户端发出的
>   换发请求，第三方 HTTP 客户端（Node / curl / Chromium 131 均实测）一律返回
>   `40115 session not found`。NAS 请按 **每 7 天导入一次凭据** 运维；PC 上则用
>   `gui-companion` 模式跟随桌面版。详见 2.3。

---

## 0. 架构与数据流

```
NAS / Linux Docker（x86_64 或 ARM64，原生无仿真）
  ta2api 容器
    ├─ Node.js 跑 server.mjs → shim（三协议端点 + 管理台，监听 0.0.0.0:8787）
    ├─ 静态 Go 内核 TeleAgent（从官方 deb 提取，无需 GUI 库）
    │    └─ 登录态来自 /app/runtime/credentials/store.json（容器自管，支持续期）
    └─ 凭据续期循环：每 6h 调官方 token-refresh → 新 token 落库 → 换核热生效

PC（可选，两条路径二选一）
  A. 拷贝账号「非密」配置文件（模型目录等）→ NAS 管理台登录
  B. node docker/export-credentials.mjs（离线迁移，连 token 一起导）
```

关键点：
- 内核是**完全静态链接**的 Go 二进制（实测 `PT_INTERP=None, PT_DYNAMIC=False`），
  x64 (`machine=0x3e`) 与 arm64 (`machine=0xb7`) 都不依赖 glibc / GTK / X11。
- 换发协议**不走内核签名**：官方桌面端源码（app.asar AuthRenewal 模块）明示
  `POST /cowork/auth/token-refresh` 用 `X-Token` + `X-Timestamp` + `X-Nonce` +
  `X-App-Version` + `X-OS-Type` + `X-SuperAgent-Device-Id` 六个头、空 body——
  注释原话「换新/logout 与现网一致使用 X-Token，不引入 Bearer」。
  所以代理可以脱离内核独立续期。
- 三协议（OpenAI chat / Responses / Anthropic messages）与逐字流式修复都在这套代码里。

---

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| NAS | Docker + Docker Compose；x86_64 或 ARM64 均可（原生，不需要 QEMU 仿真） |
| 网络 | NAS 能访问官方网关（与桌面端相同）；局域网内有一台能开浏览器的设备做首次登录 |
| PC（可选） | 只在「拷贝账号配置」或「离线迁移」时用到；已登录 TeleAgent 桌面端 |
| 磁盘 | 镜像约 120MB；数据卷 <10MB（凭据库 + 内核数据 + 密钥表） |
| 网关 key | `sk-` 开头的上游网关密钥（从 PC 的 app.asar 或现有 `local.secrets.json` 取，不随仓库分发） |

---

## 2. 账号配置与首次登录

### 2.1 准备账号「非密」配置（一次性）

TA2API 启动需要四类**非密**文件（从已登录桌面端的 PC 拷贝）：

```
data/TeleAgent/                       ← 挂载为容器 /data/TeleAgent
├── current-owner.json                ← 桌面端数据目录根下
├── runtimes/.version.json            ← 内核版本号
└── users/<ownerDir>/
    ├── model-catalog.json            ← 模型目录（缺了代理起不来）
    └── preset-context.json           ← 上下文长度等偏好（建议一并拷）
```

在 PC 上这些文件位于 `%HOMEPATH%\.local\share\TeleAgent\` 对应位置。
如果跑过 `docker/export-credentials.mjs`（第 2.4 节），这些文件已自动汇总在
导出目录的 `TeleAgent-layout/` 里，整体拷过来即可。

### 2.2 首次登录（用浏览器 Cookie 拿到可用 token）

> 2026-11-21 实测结论：**不要试图从登录回执页复制 token。**
> 桌面端 OAuth 链（`.../cowork/auth?source=01`）授权后会停在
> `.../cowork/auth?appVersion=&code=ucc.…`，页面立刻尝试唤起 `teleagent://` 客户端，
> 既来不及复制，code 也在浏览器加载那一刻被消费掉（拿它重放一律
> `400 {"error":"get token error"}`）。这条路无解，已放弃。
>
> 可用通道是**平台 Cookie**：`operationToken` 的值是 `<租户>:<accessToken>`，
> 其中 accessToken 与凭据库里的 `token` **逐字节相同**（实测 639 字节完全一致）。
> 拿到它就等于拿到一个可用的登录 token。
>
> ⚠ **这一节只解决「有 token 可用」，不解决「能不能自动续期」。**
> 续期还要服务端存在对应的「换发会话」，而该会话不在 Cookie 里——
> 详见 2.3 节末尾的实测与限制。

1. 启动容器（见第 6 节）。日志会显示「尚未登录：内核暂不启动」，属预期状态。
2. 局域网浏览器打开 `http://NAS_IP:8787/admin?token=<TA_ADMIN_TOKEN>`，
   顶部有「登录态与自动续期」面板。
3. 点「登录账号」→「打开官方登录页」：新窗口打开网页版登录页
   `https://agent.teleai.com.cn/meter/teleagent-login/login`，用短信验证码完成登录。
   **跳进 `/teleagent` 网页版界面是正常现象**——目的只是让浏览器拿到 Cookie。
4. 在该窗口取 Cookie，两种方式任选：
   - **A（最省事，推荐）**：F12 → **Network** → 刷新 → 点任意一条发往 teleai 的请求 →
     Request Headers 里的 `cookie:`，复制冒号后**整段**（天然包含两个值）。
   - **B**：F12 → **Application** → **Cookies** → `agent.teleai.com.cn` →
     复制 `operationToken` 的值（形如 `Em9xR4:eyJhbGci…`）。
5. 回到管理台「用 Cookie 登录」框粘贴 → 点「导入并登录」。
   凭据写入、内核自动拉起，`generation` 加一，日志出现
   `[teleagent] cookie 成功：generation=…`。
6. 验证：按第 7 节发一次对话请求，应返回 200。

> 只给 `operationToken` 也能登录（已实测）；`operToken` 只影响换发，不影响对话。
> 方式 A 天然成对，推荐。
>
> **NAS 上没有浏览器/F12 怎么办**：Cookie 与设备无关。在任意一台电脑的浏览器登录同一账号、
> 取出 Cookie，再粘到 NAS 的管理台即可。或者直接走 2.4 节的 PC 导出迁移。

**为什么必须手工粘一次**：反代跑在 `127.0.0.1` 或 NAS 局域网地址，与
`agent.teleai.com.cn` 不同源，浏览器同源策略不允许跨站读取 Cookie；
官方也未提供「登录后自动把 token 送到第三方地址」的通道
（`redirect_url` 由服务端写死为 `…/cowork/auth?appVersion=`，实测传
`redirect_url` / `redirectUri` / `state` 均不回显）。

> 登录入口地址已内置（`DEFAULT_LOGIN_PAGE_URL`），只有官方换域名时才需要用
> `TA_LOGIN_PAGE_URL` 覆盖。


### 2.3 自动续期（⚠ 2026-11-21 实测：容器内不可行）

**结论**：反代在容器/NAS 中**无法完成 token 换发**。服务端会拒绝一切非官方桌面
客户端发出的换发请求，与凭据是否最新无关。NAS 部署请按「定期导入凭据」运维
（见本节末尾），不要指望自动续期。

#### 实测证据

| 步骤 | 结果 |
|---|---|
| 桌面版启动补偿换发 | ✅ `token-refresh succeeded ttl=604798s` |
| 同一会话再换一次（清 `renewal-schedule.json` 后重启桌面版） | ✅ `succeeded ttl=604799s` —— 会话**可重复使用**，非一次性消费 |
| 用桌面版换发**产出**的最新凭据，Node fetch 重放 | ❌ `401 40115 session not found` |
| 同上，curl 8.21（Schannel TLS 栈） | ❌ 40115 |
| 同上，Edge / Chromium 131（Playwright，页面内同源 fetch + 注入 Cookie） | ❌ 40115 |
| 换 `X-App-Version`：`3.1.1.000` / `3.1.1` / 空 | ❌ 全 40115 |
| 换 `deviceId`：`e8b0c51f3439`（WLAN MAC 去分隔符小写） / `56c55713-…`（`desktop-device-id.json`） | ❌ 全 40115 |
| 换 UA（无 / Electron TeleAgent / Chrome+sec-ch-ua）、加 `Origin`+`Referer`、Cookie 反序、Accept 族 | ❌ 全 40115 |

已排除：凭据过期、Cookie 未轮转、`deviceId` 错误、版本号/UA 不匹配、双客户端竞争、
会话一次性消费。**唯一剩余解释**：服务端按客户端的 TLS/HTTP 栈特征识别身份
（最可能是 JA4 指纹——Electron 32 用的是 Chromium 128，Edge 131 也不匹配），
第三方 HTTP 客户端一律不认。

旁证：`operToken` 的 `jwtInfoId` 每次换发都会变（旧值随即失效），说明服务端确实
维护着会话状态；但仅凭这条索引无法冒充客户端。

#### NAS 怎么办

**方案 A（推荐）：容器 + 每 7 天导入一次凭据**

token TTL 为 7 天。在任意装有桌面版的 PC 上（桌面版需已登录、并**先退出**
—— Cookie 库是独占锁，运行中读不了）：

```bash
node docker/export-credentials.mjs docker/ta-export
```

两种方式落地到 NAS：
- 拷 `docker/ta-export/credentials/*.json` 到 NAS 的 `data/runtime/credentials/`；
- 或在管理台「用 Cookie 登录」直接粘贴 `operationToken`（更省事，不用拷文件）。

判据：管理台顶部显示 token 到期时间，剩余 2 天以内就该更新。

**方案 B：PC 上跑反代（gui-companion）**

反代检测到桌面版数据目录（`Local State`）时自动进入该模式：换发整体停用，
改为**跟随**桌面版的 token 更新（每 60s 比对 `token.json` 指纹，按 JWT `iat`
「谁新用谁」）。这是 PC 场景的正确形态，也是目前唯一能长期免维护的用法。

**方案 C（不推荐）：容器内跑官方 Electron 客户端本体**

理论可行（换发需要它的网络栈），但镜像 +1GB、需要图形栈，且与「用内核做反代」
的初衷冲突。

#### 实现保留（PC 场景与将来参考）

以下能力仍保留，gui-companion 之外或官方将来放开时会用到：

- **协议**：`POST <网关>/superCowork/sapi/cowork/auth/token-refresh`，六个头 + 空 body，
  超时 10s；响应 `data.accessToken` / `expiresIn` / `absoluteExpiresAt`。与官方
  `AuthRenewal.$St()` 逐函数核对一致（含 `X-Nonce` 用 UUID、`X-Timestamp` 用秒）。
- **Cookie 来源优先级**：`store.json` → 桌面版 partition Cookies（Node ≥22.13，
  自动回写自管库）→ 管理台「导入 Cookie」。
- **节奏**：启动补偿 + 每 6h（`TA_RENEW_INTERVAL_MS`，默认 21600000），
  同一自然日只尝试一次；可重试失败不占用当日额度。`0` = 完全关闭。
- **换核**：成功后新 token 落库 → `authState` 热替换 → `spawnAndSwap` 热换。
- **终态失败**（40112~40116）：管理台提示「自动续期失败（<category>）」，
  **不再误报 token 失效**——若 token 仍有效会明确写出到期时间。
- **双模式**：`TA_RENEW_MODE=nas|gui` 可显式覆盖自动判定。

#### 排障：40115 怎么读

| 现象 | 含义 |
|---|---|
| 对话正常 + 续期 40115 | token 还能用、只是续不上——**容器内属常态**，按方案 A 定期导入即可 |
| 对话也 401 | token 真过期了，重新导入凭据 |


### 2.4 可选：PC 离线迁移（不想在 NAS 上做首次登录）

```powershell
cd "D:\Program Files\TA2API"
node docker\export-credentials.mjs D:\ta-export
```

产物拷贝到 NAS：

```
ta-export/credentials/{store.json, device.json}   → /app/runtime/credentials/
ta-export/TeleAgent-layout/…                      → /data/TeleAgent/
```

`store.json` 含明文 token 与平台 Cookie 对（等同账号凭据）：权限 600、不进 git、不外传。
NAS 端启动即用，后续续期照常（`generation` 会从 1 开始递增）。
导出脚本会一并提取 owner partition 的 `operToken`/`operationToken` Cookie——
这是换发会话定位要素（见 2.3）；若导出时提示 Cookie 失败，NAS 端在管理台
「导入 Cookie」补录即可。
`device.json` 与 PC 端同身份——token 与设备标识保持配对，与官方客户端行为一致。

---

## 3. 准备 Linux 内核载荷

随附提取脚本 `docker/extract-payload.py`（纯标准库，流式处理，不落 500MB 中间文件）：

```bash
# amd64（x86_64 NAS / PC）
python3 docker/extract-payload.py ~/Downloads/TeleAgent-3.1.1-amd64.deb amd64
# arm64（ARM NAS）
python3 docker/extract-payload.py ~/Downloads/TeleAgent-3.1.1-arm64.deb arm64
```

脚本自带 sha256 校验（amd64 应为 `26f1008b4066c45a1eb5f193261d5aa78f1b4a5dab3c7040d924ec66c4c11b40`），
输出直接落到 `docker/payload/`：

```
payload/
├── TeleAgent-linux-amd64       （48,300,194 字节，3.1.1）
└── TeleAgent-linux-arm64       （arm64 机器上从 arm64 包提取）
```

两架构二进制都是静态的，不需要任何 `.so`。**只需提取你要部署的那个架构**——
Dockerfile 只 `COPY` 与构建架构同名的那一个文件。

---

## 4. 已内置能力（本版无需打补丁）

2026-11-20 版代码已把 NAS 需要的能力全部内置（`git apply` 补丁流程取消）：

| 能力 | 实现位置 |
| --- | --- |
| 局域网访问（`TA_HOST=0.0.0.0`） | `server.mjs` createShim 传 `host`；shim 原生支持 |
| 内核看门狗 + 存活检查 + 先起后换 | `server.mjs`（`TA_WATCHDOG_MS`） |
| 自管凭据库（明文 token，无 DPAPI 依赖） | `lib/credentials.mjs` + `server.mjs` 启动降级链 |
| 官方 token-refresh 自续期 | `lib/credentials.mjs`（协议复刻，离线单测 28 项）—— ⚠ 容器内服务端会拒绝，见 2.3 |
| 管理台登录（iframe postMessage / 粘贴回跳） | `web/admin.html` + `/admin/api/auth/*` |
| 管理台远程访问 | `TA_ADMIN_ALLOW_REMOTE=1` + 强制 `TA_ADMIN_TOKEN` |

凭据来源优先级：`runtime/credentials/store.json` > 桌面端 DPAPI token.json（Windows 兼容）
> 无（等待管理台登录）。三档都允许启动，缺失时由管理台补齐。

---

## 5. Dockerfile 与 compose

随附文件：`docker/Dockerfile`、`docker/entrypoint.sh`、`docker/docker-compose.yml`、
`docker/.env.example`。要点：

- `Dockerfile`：`TARGETARCH` 自动选内核；只装 Node + tini，无桌面库。
- `entrypoint.sh`：软链 `~/.local/share/TeleAgent → /data/TeleAgent`、
  摆内核到 `runtimes/super-agent-code/bin/`、读 gateway key secret、
  建 `/app/runtime/credentials/`。
- `docker-compose.yml` 两个卷**都必须挂**：

```yaml
    volumes:
      - ./data/TeleAgent:/data/TeleAgent   # 账号配置（非密）
      - ./data/runtime:/app/runtime        # 凭据库 + API 密钥表 + 内核数据/日志（必须持久化！）
```

  漏挂第二个卷的话，登录态和密钥表在容器重建后全部丢失。
- `.env`（由 `.env.example` 复制）：`TA_API_KEY`、`TA_ADMIN_TOKEN` 必填；
  `TA_LOGIN_PAGE_URL` 已内置默认值、平时留空；`TA_WATCHDOG_MS` / `TA_RENEW_INTERVAL_MS`
  默认已按 7×24 设好。

---

## 6. 落地步骤（x86_64 与 ARM64 通用）

```bash
# 0) 目录准备
/volume1/docker/ta2api/
├── docker-compose.yml  .env  gateway_key.txt
├── data/TeleAgent/{current-owner.json, runtimes/.version.json, users/<ownerDir>/…}
├── data/runtime/                      # 空目录即可（首次登录后自动生成 credentials/）
└── payload/TeleAgent-linux-amd64      # ARM64 NAS 改用 ...-arm64

# 1) 校验内核
cd payload && sha256sum -c <<'EOF'
26f1008b4066c45a1eb5f193261d5aa78f1b4a5dab3c7040d924ec66c4c11b40  TeleAgent-linux-amd64
fd3a5f979305645d5b4ec847762276a5407ad055f735e89a1ae5bdd09aafaffc  TeleAgent-linux-arm64
EOF

# 2) 构建并启动
cd .. && docker compose up -d --build
docker logs -f ta2api
# 预期：[teleagent] 尚未登录：内核暂不启动。请打开管理台完成登录。

# 3) 浏览器打开管理台登录（第 2.2 节），完成后日志出现：
#    [teleagent] 登录成功：generation=1 · token 到期 …
#    [teleagent] 内核已就绪：…

# 4) 验收：局域网内任意机器
curl http://NAS_IP:8787/v1/models -H "Authorization: Bearer $TA_API_KEY"
curl http://NAS_IP:8787/v1/messages -H "x-api-key: $TA_API_KEY" \
     -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
     -d '{"model":"chat-flash","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'

# 5) 续期验收（登录成功后）
curl -s http://NAS_IP:8787/admin/api/auth -H "x-admin-token: $TA_ADMIN_TOKEN"
# 关注 generation / tokenExpiresAt / lastAttempt；次日 generation 应 +1
```

管理台：`http://NAS_IP:8787/admin`（远程访问需 `TA_ADMIN_ALLOW_REMOTE=1` 且带令牌）。

### 6.1 内核自愈（NAS 无人值守的前提）

内核可能被外部静默终止（实测案例：PC 上退出 TeleAgent 桌面版会按镜像路径清场，
把反代拉起的内核一起杀掉）。旧版 `server.mjs` 的缺陷会让一次猝死变成永久故障。
现已改为：

- 每次请求先判内核存活，死了就按同一 key 自动重启；
- 切换顺序「先起新的 → `waitReady` → 再关旧的」，中途失败不留空窗；
- 切换与重启串行化，避免并发请求互相杀掉对方正在预热的内核；
- 看门狗每 `TA_WATCHDOG_MS`（默认 15000ms）检查一次，空闲时内核死了也会自己起来。

> **Linux 专有陷阱（2026-11-21 Docker 实测抓到并已修）**：进程被**信号**杀死
> （`SIGKILL` / OOM killer / `SIGSEGV`）时，Node 只设 `proc.signalCode`，
> `proc.exitCode` **保持 null**。旧判据 `proc.exitCode !== null` 在 Linux 容器里
> 会把死进程判成活的 → 看门狗永不触发、所有请求毫秒级 `fetch failed`，
> 表现为「容器在跑但完全不可用」。Windows 因 TerminateProcess 有退出码而从未暴露。
> 现判据：`exitCode !== null || signalCode != null`（`server.mjs` `kernelDead()`、
> `lib/kernel.mjs` `waitReady()`）。

> 实测：Windows 上 `taskkill` 掉内核后约 28 秒自动复活；Linux 容器内
> `kill -9` 后 **+11 秒**复活并刷新 `/healthz` 的内核端口。
> Docker 的 `restart: unless-stopped` 只管外层进程，内层内核由看门狗负责。

---

## 7. 已验证 / 未验证（如实标注）

**已验证（本工作区实测）**
- deb 结构、内核静态属性、两架构 sha256（`docker/DEB_ANALYSIS.txt`）。
- 换发协议：app.asar 主进程 AuthRenewal 模块逐函数提取（`kNe/FEt/OEt/aI`），
  与桌面端运行日志（11-16~11-20 每日 `token-refresh succeeded ttl=604799s`）互相印证。
- 凭据模块离线单测 **28/28**（`npm run test:credentials`，全部请求打在本机 mock 网关）：
  请求头/空 body/URL、五类终态业务码、50005/5xx 重试、404 unsupported、超时、
  存储原子写、设备身份生成与持久化、当日去重、禁用语义。
- 冒烟启动：`TA_RENEW_INTERVAL_MS=0` 下第二实例正常拉起内核，
  `/admin/api/auth` 返回完整状态（未向生产网关发任何请求）。
- 三协议工具回归 26/26（`npm run test:tools`）。

**已验证（2026-11-21 本机 Docker Desktop 4.99 / Engine 29.9.3，linux/amd64 真实容器）**

| 项目 | 结果 |
| --- | --- |
| 镜像构建 | 成功；上下文 48.5MB（`.dockerignore` 生效，未把 `reverse/` 564MB 与凭据打进上下文）；镜像内内核 sha256 与提取物一致 |
| 容器启动 | 内核 3.1.1 在容器内就绪，模型目录 `chat-pro / chat-flagship / chat-flash` 全部加载 |
| 凭据加载 | `source=credentials`（`store.json`），`platformCookies: operToken+operationToken=true` |
| OpenAI `POST /v1/chat/completions` | 200，2.0s，真实回复（非流式 + 流式 SSE 增量均正常） |
| Responses `POST /v1/responses` | 200，`object=response`，`output_text` 正常 |
| Anthropic `POST /v1/messages` | 200，`content[0].type=text`，`stop_reason=end_turn` |
| 工具中继（OpenAI tools） | 第一轮 `finish_reason=tool_calls`，函数名/参数原样回传；第二轮回灌 `role:tool` 后 `finish_reason=stop`，模型用「26℃ 多云」作答——**闭环成立** |
| 鉴权 | 业务端点无 key → 401；`/v1/models`、`/healthz` 为公开端点（网关惯例） |
| 管理台（本机模式） | 端口绑 `127.0.0.1` + `TA_ADMIN_LOCAL_ONLY=1`：宿主浏览器打开 `127.0.0.1:8787/admin` 直接 200，免令牌；局域网不可达 |
| 管理台（远程/令牌） | 无令牌 → 403 且返回**令牌输入页**（不再裸 JSON）；错令牌 → 403；正确令牌 → 200 |
| 退出登录 | `POST /admin/api/auth/logout` → `hasToken:false`、内核停机、Cookie 对保留；业务端点随即返回 `401 need_login`（1.2s 内，不挂起） |
| 登录通道 | 粘贴回跳网址 → 解析 token → 落库 `generation+1` → 自动拉起内核 → 对话 200（实测 generation 1→3 往返） |
| 局域网访问 | 宿主 LAN IP 访问 `8787` 正常（`TA_HOST=0.0.0.0` 生效） |
| 内核自愈 | 容器内 `kill -9` 内核 → **+11s** 自动重启，`/healthz` 端口刷新，随后对话 200 |
| 持久化 | `data/runtime/` 下 `teleagent.db`、`api-keys.json`、`credentials/`、内核日志均在卷内；容器重启后凭据与 `generation` 不变 |

**已验证的负面结论（2026-11-21，实打实做过）**
- **容器内换发不可行**：桌面版能连续两次换发成功，而拿它换发产出的最新凭据
  （token / operToken / deviceId / 各项头部全部核对过）在 Node fetch、curl、
  Chromium 131 上重放均 `40115`。详见 2.3 的完整对照表。
- ~~浏览器独立登录拿 token~~ —— 已证伪并放弃：桌面端 OAuth 链授权后回执页只有 `code`、
  且立刻唤起 `teleagent://`；code 在浏览器加载那一刻即失效（重放 400 get token error）。
  现改为「网页版登录 → 复制平台 Cookie → 管理台导入」，见 2.2 节。
  该通道已在本机容器实测：`generation 4 → 5`，对话 200。
- `ghcr.io/ghg6666678/ta2api` 镜像是否存在（gh 无 `read:packages` scope）；
  本文走本地构建，不依赖 GHCR。
- ARM64 容器实跑（本机为 x86_64；arm64 内核只做了 ELF 头鉴定与 sha256 核对）。

---

## 8. 已知限制与风险

1. **约 90 天会话绝对期限。** 官方协议 `40116 session_absolute_expired`——若续期不滚动
   延长绝对期限，最坏每 ~90 天需在管理台重新登录一次（全自动日常运行不受影响）。
   首次真实续期后从 `absoluteExpiresAt` 字段即可确认语义。
2. **凭据是明文。** `store.json` 与官方客户端内存中的 token 同级敏感：
   NAS 私有目录、不进 git、不外传。管理台远程访问强制令牌。
3. **风控纪律。** 续期严格复刻官方请求形态（同端点、同头、空 body、同节奏），
   绝不改字段做试探；失败重试遵循官方当日一次的节奏。账号级封禁（40105~40109）
   与本机制无关，但请勿在本部署上叠加并发压测。
4. **强制鉴权建议自己加。** `TA_API_KEY` 为空则端点无鉴权；局域网暴露前务必设
   `TA_API_KEY` + `TA_ADMIN_TOKEN`（compose 已强制要求填写）。
5. **并发串话风险仍在。** 全局 bridge + 会话键退化问题（见
   `reverse/teleagent-kernel/CONCURRENCY_AND_SESSION_FAILURES.txt`）与部署无关，
   多客户端并发时注意显式传会话 id。
6. **首次启动耗时。** 内核首次启动约 1–2 分钟，健康检查别设太短。
7. **跨协议调用会重启内核。** 内核的 agent 提示词要跟调用方一致（OpenAI 客户端 / Codex 风格 /
   Claude 风格各一套），所以 chat → responses → messages 交替调用时每次都换核。实测
   6 次交替请求触发 **5 次重启**（每次 1–2s，且会清空挂起会话）。NAS 上建议**同类客户端为主**；
   多协议混跑时请显式传 `user`/`conversation_id` 区分会话，并接受切换开销。
8. **挂起工具调用的残留。** 若上一轮工具调用被客户端中途放弃（超时/断连），其挂起项会留在
   bridge 里，下轮 `resolve()` 会给它回空字符串；换个协议的客户端可能看到一次「无意义重试」。
   实战中新建会话即可，不影响正确性。

---

## 9. 与 docs/nas-docker.md 的差异（为什么这样写）

| 项目 | docs/nas-docker.md (v0.7.5 设计) | 本文（2026-11-20 实际） |
| --- | --- | --- |
| 凭据 | PC 导出主密钥 → Linux 解密（依赖 PC） | 管理台登录 + 自管凭据库，PC 仅可选迁移 |
| 续期 | renew 容器（设计） | 官方 token-refresh 协议复刻，每 6h 自动，离线单测 28 项 |
| 局域网访问 | `TA_ADMIN_ALLOW_REMOTE=1`（当时不存在） | `TA_HOST` 内置 + `TA_ADMIN_ALLOW_REMOTE`（已实现，远程强制令牌） |
| 镜像 | GHCR 多架构清单（未验证存在） | 本地构建，TARGETARCH 选内核 |
| 内核自愈 | 无 | 看门狗 + 存活检查 + 先起后换（实测 Windows 28s / Linux 11s 复活） |
| Python/Node/ripgrep | 从 Release 载荷下载 | 容器只需 Node；内核静态，其余不需要 |

---

## 10. 常见故障（实测踩坑）

### 10.1 Windows 上 `docker` 命令不存在 / `docker-credential-desktop` 找不到

Docker Desktop 装在用户目录时不会写系统 PATH：

```powershell
$bin = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin"
$env:PATH = "$bin;$env:PATH"
docker version
```

`error getting credentials - exec: "docker-credential-desktop": executable file not found`
是同一个原因（`~/.docker/config.json` 里的 `credsStore: desktop` 需要该助手在 PATH 里）。

### 10.2 构建报 `COPY docker/payload/TeleAgent-linux- failed`

两种可能：

1. `payload/` 里没有对应架构的文件 → 跑第 3 节的 `extract-payload.py`。
2. **`TARGETARCH` 被传成空值**。compose 里若写 `args: TARGETARCH: ${TA_ARCH:-}`，
   `.env` 没设 `TA_ARCH` 时会把 BuildKit 自动注入的架构覆盖成空字符串 → COPY 找不到文件。
   本仓库的 compose 已删掉该行，改用 BuildKit 自动架构；交叉构建请用
   `docker buildx build --platform linux/arm64 ...`。

### 10.3 容器 `Up` 但所有请求 `502 fetch failed`，且日志无新内容

内核已死但代理没察觉。2026-11-21 前的版本在 Linux 上必现（信号退出判据缺陷，
见 6.1）。确认并升级：

```bash
docker compose build --no-cache && docker compose up -d
docker exec ta2api sh -c 'for d in /proc/[0-9]*; do tr "\0" " " < $d/cmdline; echo; done' | grep TeleAgent
```

### 10.4 `[entrypoint] 缺少 /data/TeleAgent` 后容器退出

`data/TeleAgent/` 里必须有 `current-owner.json`（第 2.1 节）。空目录不算——
入口脚本据此判断「是否已完成账号配置」，避免起一个必然失败的内核。

### 10.5 宿主机浏览器打开 `127.0.0.1:8787/admin` 提示「管理台仅允许本机访问」

这是容器带来的假象，不是权限真的坏了。宿主机 → 容器的流量在容器内看是**网桥网关地址**
（如 `172.17.0.1`），和「局域网另一台机器」完全一样，`isLoopback()` 分辨不出来。

按你的场景选一种：

**A. 这台机器自己用（PC，推荐）** —— 端口只绑宿主回环 + 声明本机模式：

```yaml
ports: ["127.0.0.1:8787:8787"]          # 或 .env 里 TA_BIND_ADDR=127.0.0.1
environment:
  TA_ADMIN_LOCAL_ONLY: "1"              # 端口没暴露到局域网 → 免令牌
```

`http://127.0.0.1:8787/admin` 直接进，不再问令牌，局域网也连不上这个端口。

**B. NAS，给别人从别的设备用** —— 必须暴露端口 + 令牌：

```yaml
ports: ["0.0.0.0:8787:8787"]
environment:
  TA_ADMIN_ALLOW_REMOTE: "1"
  TA_ADMIN_TOKEN: "换成足够长的随机串"
  TA_ADMIN_LOCAL_ONLY: "0"              # 关键：0.0.0.0 时绝不能设 1
```

从笔记本访问 `http://<NAS-IP>:8787/admin` 会看到一个**令牌输入页**（不是裸 JSON 报错），
粘贴 `TA_ADMIN_TOKEN` 即可进入；之后的请求用 `?token=` 或 `x-admin-token`，
撤销就是换一个 token 再重启。

> 两个开关是**互锁**的：`TA_ADMIN_LOCAL_ONLY=1` 但端口绑 `0.0.0.0`，
> 等于把管理台无鉴权地送到局域网——部署指南把这条写在 `.env.example` 里，别踩。

### 10.6 想验证「登录功能」本身，别用导出的凭据

可以用管理台的 **「退出登录」** 按钮构造出真正的未登录态（不用手工删文件）：

1. 管理台 →「登录态与自动续期」→「退出登录」；
2. 凭据清空、内核停机，状态变 `hasToken:false`、`needLogin` 有提示；
   此时业务端点返回 `401 {"code":"need_login","message":"尚未登录：请在管理台 /admin …"}`；
3. 按 2.2 节粘贴平台 Cookie（`operationToken` / 完整 Cookie 头）并点「导入并登录」，
   成功后 `generation + 1`、内核自动拉起。

`POST /admin/api/auth/logout` 即同一动作，脚本化测试用。
「退出登录」只清 token，**保留** `operToken/operationToken` 这对 Cookie（换 token 后仍可复用）。
