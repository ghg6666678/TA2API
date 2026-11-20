# TeleAgent + TA2API 的 Linux / NAS Docker 部署指南（自给自足版）

> 本文按 **2026-11-20 版 TA2API 代码**（v0.3.3 + 三协议工具中继 + 逐字流式 + 看门狗 +
> 凭据自续期）和 **TeleAgent 3.1.1 官方 Linux deb 实测**编写，不是照抄 `docs/nas-docker.md`
> （那份是 v0.7.x 的设计稿，其中多数能力当时不存在；本版把其中真正有价值的部分——
> 局域网访问、自动续期——以实测协议复刻实现了，详见 `docker/DEB_ANALYSIS.txt`）。
>
> 结论先行：**NAS 部署完全自给自足**——
> - 首次登录在管理台完成（官方登录页 iframe 或粘贴回跳网址），不需要 PC 在场；
> - 登录后每天自动续期（复刻官方 `token-refresh` 协议），7 天 token 永不过期；
> - 唯一的硬限制：**会话有 ~90 天绝对期限**（官方协议 `40116 session_absolute_expired`），
>   届时在管理台重新登录一次即可，仍是全自动的日常运行。

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

### 2.2 NAS 首次登录（浏览器完成，无 PC 依赖）

1. `docker compose up -d --build` 启动容器（见第 6 节）。
   日志会出现「尚未登录：内核暂不启动。请打开管理台完成登录」——这是预期状态。
2. 局域网浏览器打开 `http://NAS_IP:8787/admin?token=<TA_ADMIN_TOKEN>`，
   顶部出现「登录态与自动续期」面板。
3. 点「打开登录页」：弹窗内嵌**官方登录页**（桌面端与官方 Web 登录壳内嵌的是同一个页面，
   支持短信验证码），登录完成后官方页面向父窗口 `postMessage {type:'loginRedirect', url}`，
   管理台自动捕获、提取 token、写入凭据库并拉起内核——全自动。
4. 若 iframe 通道被浏览器策略干扰，用备用通道：在**任意设备**的浏览器里直接打开官方登录页
   完成登录，登录结束后把浏览器地址栏的**完整回跳网址**（路径含 `/cowork/auth`、参数含
   `token=`）粘贴进管理台弹窗底部的输入框提交。两条通道走同一个后端接口。

> 官方登录页地址通过环境变量 `TA_LOGIN_PAGE_URL` 配置（见 `.env.example` 与第 5 节）；
> 不配置时 iframe 按钮会提示改用粘贴通道，功能不受影响。
> 回跳网址形如：网关域名 `/superCowork/sapi/cowork/auth?code=…&token=…`——
> 与桌面端 LoginWindow 的 `did-navigate` 判定条件完全一致（代码逆向依据，
> 见 `reverse/teleagent-kernel/asar-extract/`）。

### 2.3 自动续期（登录一次后的日常运行）

- **协议**（官方 AuthRenewal 模块逐函数核对 + 桌面端日志旁证）：
  `POST <网关>/superCowork/sapi/cowork/auth/token-refresh`，六个头 + 空 body，超时 10s；
  响应 `data.accessToken` / `expiresIn` / `absoluteExpiresAt`。
  每次成功后 TTL 重置回 7 天（桌面端日志实测 `ttl=604799s`）。
- **⚠ 平台 Cookie 对（operToken / operationToken）是换发会话定位要素**：
  2026-11-20 实证，官方桌面端的换发请求经 Electron net.fetch 自动携带
  `.teleai.com.cn` 域的这对 Cookie（登录页响应 Set-Cookie 种下，明文存于
  owner partition 的 Cookies 库）；**只发六个头、不带 Cookie 会被服务器判
  `40115 session_not_found`**（「手动续期」报「凭据已失效」就是这个原因）。
  TA2API 的换发已带上 Cookie，来源优先级：
  1. 自管库 `store.json` 的 `cookies` 字段（NAS 主通道）；
  2. PC 兼容通道：运行时从桌面端 partition Cookies 库读取（Node ≥22.13，自动回写自管库）；
  3. 管理台「导入 Cookie」：浏览器登录页 F12 → Network → 任选一个
     teleai.com.cn 请求 → 复制请求头完整 Cookie 粘贴。
  换发成功后服务器 Set-Cookie 下发新一代 Cookie 对，TA2API 自动落库——**自持**。
- **节奏**：与官方客户端一致——启动补偿 + 每 6h（`TA_RENEW_INTERVAL_MS`，默认 21600000），
  同一自然日只尝试一次；可重试失败（网络/5xx/50005）不占用当日额度。
- **换核**：续期成功后新 token 落库 → `authState` 热替换 → 走与提示词切换相同的
  spawnAndSwap 链换核（新内核就绪后才关旧的）。
- **终态失败**（40112~40116 / HTTP 401）：管理台亮红色横幅「请重新登录」，
  日常运行不中断尝试。其中 `40116` 即**约 90 天的会话绝对期限**——
  最坏情况每 90 天需要在管理台重新登录一次。
- **完全关闭**：`TA_RENEW_INTERVAL_MS=0`（只保留管理台「手动续期」按钮）。
- **双客户端竞争**：同一账号同时跑桌面端与 TA2API 时，两边的成功换发都会使对方
  手里的 token 变为上一代（服务器轮转 + 吊销宽限）。PC 上建议二选一：要么桌面端
  换发（TA2API 设 `TA_RENEW_INTERVAL_MS=0` 跟随），要么 TA2API 独占换发。
  NAS 部署天然无此问题。

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

从两个 deb 里提取 `super-agent-code-linux-*.tar.gz`（Windows 上可用随附脚本，
或在任意有 Python 的机器按 `docker/DEB_ANALYSIS.txt` 第二节手工提取）。
放到 NAS 的 `docker/ta2api/payload/`：

```
payload/
├── TeleAgent-linux-amd64       （x64 内核，从 super-agent-code-linux-x64.tar.gz 解出，改名）
├── TeleAgent-linux-arm64       （arm64 内核，从对应包解出，改名）
└── SHA256SUMS                  （写入第 6 节给出的校验值）
```

两架构二进制都是静态的，不需要任何 `.so`。

---

## 4. 已内置能力（本版无需打补丁）

2026-11-20 版代码已把 NAS 需要的能力全部内置（`git apply` 补丁流程取消）：

| 能力 | 实现位置 |
| --- | --- |
| 局域网访问（`TA_HOST=0.0.0.0`） | `server.mjs` createShim 传 `host`；shim 原生支持 |
| 内核看门狗 + 存活检查 + 先起后换 | `server.mjs`（`TA_WATCHDOG_MS`） |
| 自管凭据库（明文 token，无 DPAPI 依赖） | `lib/credentials.mjs` + `server.mjs` 启动降级链 |
| 官方 token-refresh 自续期 | `lib/credentials.mjs`（协议复刻，离线单测 22 项） |
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
  `TA_LOGIN_PAGE_URL` 建议填官方登录页地址；`TA_WATCHDOG_MS` / `TA_RENEW_INTERVAL_MS`
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

- 每次请求先判 `proc.exitCode`，死了就按同一 key 自动重启；
- 切换顺序「先起新的 → `waitReady` → 再关旧的」，中途失败不留空窗；
- 切换与重启串行化，避免并发请求互相杀掉对方正在预热的内核；
- 看门狗每 `TA_WATCHDOG_MS`（默认 15000ms）检查一次，空闲时内核死了也会自己起来。

> 实测：手动 `taskkill` 掉内核后约 28 秒自动复活并刷新 `/healthz` 的内核端口。
> Docker 的 `restart: unless-stopped` 只管外层进程，内层内核由看门狗负责。

---

## 7. 已验证 / 未验证（如实标注）

**已验证（本工作区实测）**
- deb 结构、内核静态属性、两架构 sha256（`docker/DEB_ANALYSIS.txt`）。
- 换发协议：app.asar 主进程 AuthRenewal 模块逐函数提取（`kNe/FEt/OEt/aI`），
  与桌面端运行日志（11-16~11-20 每日 `token-refresh succeeded ttl=604799s`）互相印证。
- 凭据模块离线单测 **22/22**（`npm run test:credentials`，全部请求打在本机 mock 网关）：
  请求头/空 body/URL、五类终态业务码、50005/5xx 重试、404 unsupported、超时、
  存储原子写、设备身份生成与持久化、当日去重、禁用语义。
- 冒烟启动：`TA_RENEW_INTERVAL_MS=0` 下第二实例正常拉起内核，
  `/admin/api/auth` 返回完整状态（未向生产网关发任何请求）。
- 三协议工具回归 26/26（`npm run test:tools`）。

**未验证（需首次部署时确认）**
- 容器内端到端对话（Windows 本机无法执行 Linux ELF）。
- **真实网关的 token-refresh 调用**（协议与官方客户端逐字节一致，但按风控纪律，
  未经明确同意不向生产网关发测试请求——首次部署登录后的第一次自动续期即真实验证）。
- 登录页 iframe 的 `postMessage` 回传通道（依据官方 Web 登录壳同机制推断 + 桌面端
  注入脚本逆向；备用「粘贴回跳网址」通道不依赖它）。
- `ghcr.io/ghg6666678/ta2api` 镜像是否存在（gh 无 `read:packages` scope）；
  本文走本地构建，不依赖 GHCR。

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

---

## 9. 与 docs/nas-docker.md 的差异（为什么这样写）

| 项目 | docs/nas-docker.md (v0.7.5 设计) | 本文（2026-11-20 实际） |
| --- | --- | --- |
| 凭据 | PC 导出主密钥 → Linux 解密（依赖 PC） | 管理台登录 + 自管凭据库，PC 仅可选迁移 |
| 续期 | renew 容器（设计） | 官方 token-refresh 协议复刻，每 6h 自动，离线单测 22 项 |
| 局域网访问 | `TA_ADMIN_ALLOW_REMOTE=1`（当时不存在） | `TA_HOST` 内置 + `TA_ADMIN_ALLOW_REMOTE`（已实现，远程强制令牌） |
| 镜像 | GHCR 多架构清单（未验证存在） | 本地构建，TARGETARCH 选内核 |
| 内核自愈 | 无 | 看门狗 + 存活检查 + 先起后换（实测 28s 复活） |
| Python/Node/ripgrep | 从 Release 载荷下载 | 容器只需 Node；内核静态，其余不需要 |
