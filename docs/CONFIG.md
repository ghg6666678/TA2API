# 配置参考

## 环境变量总表

全部通过环境变量配置（`start.cmd` 里的 `set`，或直接 `set TA_XXX=... && node server.mjs`）。
改完需要重启代理生效。

### 服务

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TA_PORT` | `8787` | 本地监听端口 |
| `TA_HOST` | `127.0.0.1` | 绑定地址。局域网访问（另一台机器连过来）设 `0.0.0.0` |
| `TA_API_KEY` | 空 | 主密钥：设置后要求 `Authorization: Bearer` 或 `x-api-key`，与管理台生成的密钥并存 |
| `TA_KEYS_FILE` | `runtime/config/api-keys.json` | 管理台维护的密钥表路径 |
| `TA_DEFAULT_MODEL` | 目录第一个 | 客户端模型名匹配不上时的兜底模型 |
| `TA_FALLBACK_PROMPT` | 中性助手 | 客户端没给系统提示词时的兜底人设 |
| `TA_BUILTIN_PROMPT` | 关 | 设为 `1` 使用内核自带的星辰人设（排障用） |
| `TA_OPEN_ADMIN` | 关 | `start.cmd` 附带 `=1`：服务就绪后自动打开管理台 |

### 管理台

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TA_ADMIN_TOKEN` | 空 | 设置后 `/admin/api/*` 需要令牌（页面会提示输入） |
| `TA_ADMIN_ALLOW_REMOTE` | 关 | 设为 `1` 允许非回环地址访问管理台；**必须**配合 `TA_ADMIN_TOKEN` |
| `TA_ADMIN_LOCAL_ONLY` | 关 | 设为 `1` 表示「端口只绑宿主回环」，容器内来源无法区分本机/远程时按本机放行 |

> `TA_ADMIN_ALLOW_REMOTE=1` 与 `TA_ADMIN_LOCAL_ONLY=1` **互斥**：
> 前者用于 NAS/局域网访问（强制令牌），后者用于「端口只暴露给本机」的容器（免令牌）。
> 两个都开等于把管理台无鉴权送上局域网，代码会按 `LOCAL_ONLY` 优先，请勿这样配。

### 内核

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TA_UPSTREAM_BASE_URL` | 官方上游 | 覆盖上游地址，可指向本机抓包代理 |
| `TA_GATEWAY_KEY` | — | 上游 gateway key；也可写 `local.secrets.json` |
| `TA_ALLOW_KERNEL_TOOLS` | 关 | 设为 `1` 放行 kernel 自带的 bash/read/write 等工具（默认全禁） |
| `TA_WATCHDOG_MS` | `15000` | 内核看门狗间隔（毫秒）：进程退出即重启；也是「空闲时内核死了也会自己起来」的检查周期 |

### 凭据

PC 上 token 由桌面版刷新，反代只**跟随**（每 60s 比对一次桌面版 `token.json`，变了就换核）。
自管换发（`token-refresh`）已整体移除：服务端只认官方桌面客户端，第三方进程一律
`40115`，详见 [nas-docker.md](nas-docker.md)。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TA_FOLLOW_INTERVAL_MS` | `60000` | 跟随模式下比对桌面版 token 指纹的间隔 |
| `TA_LOGIN_PAGE_URL` | 内置官方登录页 | 仅覆盖管理台「打开官方登录页」的地址（官方换域名时用） |

> 凭据的日常运维只有两种：**桌面版自己续**（推荐，反代自动跟随），或 token 到期前
> 在管理台「用 Cookie 登录」粘一次。没有任何「自动续期」开关可调。

### 调试

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TA_TIMING` | 开 | 设 `0` 关闭 `/timing` 分段计时日志 |
| `TA_DEBUG_DIR` | 关 | 设为目录后，按请求落一份原始 body（排查协议形状用，用完记得关） |

## 获取上游 gateway key

桌面端内部有一个网关 apiKey 常量（不是你的账号凭据，但属于上游共享凭证，所以本仓库不分发）。
从本机已安装的客户端里取：

```powershell
# 客户端是 Electron 应用，明文代码在 app.asar 的 dist-electron/main-runtime-*.js
# 搜索 useSuperAgentAuth，同一对象里的 apiKey 就是
rg -a -o "apiKey:\s*\"[^\"]+\"" "D:\天翼ai\TeleAgent\resources\app.asar"
```

拿到后二选一：

```powershell
$env:TA_GATEWAY_KEY = "sk-..."          # 方式一：环境变量
```

```json
// 方式二：项目根目录 local.secrets.json（已 gitignore）
{ "gatewayKey": "sk-..." }
```

## 提示词优先级

### 三层提示词，只有一层能由客户端决定

| 层 | 来源 | 能否覆盖 |
|---|---|---|
| 内置人设 | 硬编码在 kernel 二进制里（`You are 星辰超级智能体（TeleAgent）…`，含 `# Security`、`# Language and style` 等分节） | 只能启动时替换，对话里说什么都没用 |
| agent 提示词 | `agent.build.prompt`（就是网关塞进去的那层） | **完全可替换** |
| 环境块 | kernel 自动追加在 system 末尾（模型名、工作目录、平台、日期） | 不可去掉，但只是环境信息 |

抓包实证（`npm run capture` 后看 `runtime/capture/req-*.json`）：内核**只用一条** `system` 消息，
内容是 `agent.build.prompt` + 环境块。所以只要这层被替换，模型就不会再自称星辰。

### 曾经的坑：空提示词会回落

旧实现把客户端的提示词直接当 `agent.build.prompt` 传，客户端没给时传的是**空串**，
配置里于是没有 `agent.build.prompt` 字段 —— 内核立刻回落到内置人设，于是出现：

```
用户 > 你是谁？
模型 > 我是星辰超级智能体（TeleAgent），一个协助完成日常办公与软件工程任务的子智能体。
```

修复后：**始终显式设置** `agent.build.prompt`。客户端给了就用客户端的，没给用中性兜底
`You are a helpful assistant serving an API client.`，绝不落到内置人设。

### 取哪段作为客户端提示词

| 客户端 | 取哪些字段 |
|---|---|
| Codex（`/v1/responses`） | `instructions` + `input` 里的 `developer` / `system` 消息（按顺序拼接） |
| Claude Code（`/v1/messages`） | `system`（字符串或 text block 数组，全部拼上） |
| OpenAI 兼容（`/v1/chat/completions`） | **所有** `system` 与 `developer` 消息（不再只取第一条） |

同时，system 文本**不会**再被拼进首轮用户消息 —— 它已经作为内核的 system 消息存在，
复述一遍等于给模型两份互相竞争的指令。

提示词指纹变了会**换一个 kernel**（会话映射同时清空；客户端本身每轮都会重放历史，
Codex / Claude Code 不受影响）。工具调用挂起期间不会切换，避免打断工具循环。

### 想改行为时

| 环境变量 | 作用 |
|---|---|
| `TA_FALLBACK_PROMPT` | 客户端没给提示词时的兜底人设（默认中性助手） |
| `TA_BUILTIN_PROMPT=1` | 显式使用内核自带的星辰人设（排障 / 对比用） |
| `TA_UPSTREAM_BASE_URL` | 把上游指向本机抓包代理，验证实际发出的 system |

排查方法：`npm run capture` 起代理 → 另开一个终端
`TA_UPSTREAM_BASE_URL=http://127.0.0.1:9909/superCowork/sapi/api/v1 node server.mjs` → 发一次请求 →
看 `runtime/capture/req-*.json` 里的 `messages[0]`。

### 自检：内核到底吃进了哪段提示词

每次启动 / 切换内核后，网关会回读内核的 `GET /config`，确认 `agent.build.prompt` 确实是我们下发的版本，
结果同时写进三处：

| 位置 | 看什么 |
|---|---|
| `GET /healthz` | `agent: { client, promptChars, promptSha, verified }`，`verified: true` 表示已回读确认 |
| 管理台「接入信息 → 提示词」 | 例如 `Codex 原生 · 26,043 字符 · 已校验` |
| 启动日志 | `[2026/11/17 08:23:37.786] 内核提示词：codex · 26043 字符 · 校验 通过` |

`client` 取值：`codex` / `claude` / `chat` / `neutral`（客户端没给提示词时的中性兜底）。

如果 `verified` 为 `false`，或内核里出现「星辰超级智能体」，启动日志会直接告警 ——
多半是 `TA_BUILTIN_PROMPT=1` 被设上了，或者内核版本升级后改了配置键。

离线核对（不经过网关，直接起一个内核看它吃进什么）：

```powershell
node tools/probe-prompt.mjs            # 下发一段带金丝雀的 Codex 风格提示词，看能否原样读回
node tools/probe-prompt.mjs --builtin  # 对照：内核自带人设长什么样
```
