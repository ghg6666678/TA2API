# teleagent-proxy

把本机已登录的 **TeleAgent（天翼 AI 星辰超级智能体桌面端，Windows 版）** 反代成一个
**本地 OpenAI 兼容端点**：任何支持 `base_url` 的客户端（OpenAI SDK、Cherry Studio、
DSH、Codex CLI、Claude Code 等）都能直接把它当 OpenAI / Responses / Anthropic 用。

> **免责声明**：本项目是对**本机已安装客户端行为**的互操作研究，用于把自己已有的账号接入
> 自己的工具链。仓库**不含**任何登录凭据、用户数据或上游密钥；使用前请确认你拥有该账号，
> 并自行遵守 TeleAgent 的服务条款与当地法律。仅供个人自用，**不要**对外提供代理服务、
> 转售额度或绕过计费。

```
客户端 (OpenAI / Responses / Anthropic 协议)
   │  POST /v1/chat/completions · /v1/responses · /v1/messages
   ▼
本地 shim  http://127.0.0.1:8787/v1
   │  会话映射 / 流式翻译 / 工具中继 / 错误归一
   ▼
TeleAgent 自己的 Go kernel（独立进程，独立数据目录）
   │  解密登录态 + 原生签名
   ▼
TeleAgent 上游  https://agent.teleai.com.cn/superCowork/sapi/api/v1
```

请求由 TeleAgent **自己的 kernel** 加签发出，不是复刻签名直连；登录态只在本进程内存里解密。

---

## 文档

细节都在 `docs/`，本 README 只留上手要用的部分。

| 文档 | 内容 |
|---|---|
| [docs/CLIENTS.md](docs/CLIENTS.md) | **客户端接入**：OpenAI SDK / WorkBuddy 等图形客户端 / DSH / curl / Codex CLI / CC Switch 一键注册，含工具调用开关与实测记录 |
| [docs/CONFIG.md](docs/CONFIG.md) | **配置参考**：全部环境变量（分服务 / 管理台 / 内核 / 凭据 / 调试五组）、获取上游 gateway key、提示词优先级与自检 |
| [docs/ADMIN.md](docs/ADMIN.md) | **Web 管理台**：各面板能做什么、登录态与到期提醒、密钥存储与安全边界 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **架构与内部机制**：请求链路、模块地图、内核生命周期、事件流、工具桥、登录态解密、已知限制、升级排查清单 |
| [docs/RELIABILITY.md](docs/RELIABILITY.md) | **稳定性**：内核看门狗、先起后换、会话 TTL、已知稳定性边界、排障速查 |
| [docs/nas-docker.md](docs/nas-docker.md) | **为什么没有 Docker / NAS 方案**：容器化路线的实测依据、已排除项与现在的替代用法 |
| [docs/GAPS.md](docs/GAPS.md) | **功能缺口盘点**：文档宣称但代码尚未实现的能力，及其优先级建议 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

## 快速开始

```powershell
cd teleagent-proxy
.\start.cmd
# 或者
npm start
```

启动后：

```
[teleagent] 账号 <你的昵称> · kernel 3.0.0-dev-...
[teleagent] OpenAI 兼容端点: http://127.0.0.1:8787/v1
[teleagent] 模型: chat-pro, chat-flagship, chat-flash
[teleagent] API 密钥: 0 启用 / 0 总数 · ...\runtime\config\api-keys.json
[teleagent] 管理台: http://127.0.0.1:8787/admin
```

浏览器打开 **http://127.0.0.1:8787/admin** 就是管理台：建密钥、批量停用/删除、看调用量。

前置条件（缺一不可）：

1. 已安装 TeleAgent 桌面端（`~/.local/share/TeleAgent/runtimes/super-agent-code/bin/TeleAgent.exe`）
2. 桌面端**已登录**，且至少打开过一次对话（要生成 `model-catalog.json`）
3. 本机配置上游 gateway key（**仓库不附带**）

第 3 步的做法（从本机客户端的 `app.asar` 里取，或用 `local.secrets.json`）见
[docs/CONFIG.md](docs/CONFIG.md) 的「获取上游 gateway key」。

跑完想确认环境是否健康：`npm run doctor`。

## 模型

| modelID | 名称 | 上下文 | 输出 | 积分倍率 | 建议 |
|---|---|---|---|---|---|
| `chat-flash` | 极速 | 400K | 65536 | x0.2 | 日常首选，最省 |
| `chat-pro` | 智能 | 400K | 65536 | x0.6 | 复杂任务 |
| `chat-flagship` | 旗舰 | 400K | 65536 | x1.0 | 短问答别用，烧积分 |

模型清单来自桌面端 `users/<scope>/model-catalog.json`，桌面端下发新模型后重启代理即可生效。

> 「上下文」列取自该文件的 `limits.context`，**跟随桌面端「设置 → 上下文大小」**（可选
> 200K / 400K / 600K / 800K / 1M，默认 400K）。反代的 `/v1/models` 与
> `tools/ccswitch-provider.mjs` 都读同一份文件，不会出现两边报不同值。
> 调大前请注意：客户端会按这个值决定何时压缩历史，报大了它就不压缩，真用超了反而更晚暴露问题。

> 模型名是**严格校验**的：写 `gpt-4o` / `claude-sonnet-*` 会返回 `400 unknown model`，
> 需改成上面三个之一。模型名别名路由尚未实现（见 [docs/GAPS.md](docs/GAPS.md)）。

## 接入客户端

三条协议共用同一套会话映射与工具中继，**区别只在 baseURL**：

| 客户端 | 协议 | baseURL |
|---|---|---|
| OpenAI SDK / Cherry Studio / ChatBox / WorkBuddy | Chat Completions | `http://127.0.0.1:8787/v1` |
| Codex CLI / CC Switch（`codex`） | Responses | `http://127.0.0.1:8787/v1` |
| Claude Code / CC Switch（`claude`）/ DSH | Anthropic Messages | `http://127.0.0.1:8787`（**不带** `/v1`） |

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
r = client.chat.completions.create(
    model="chat-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

`api_key` 随便填；如果启动时设了 `TA_API_KEY` 或在管理台建了密钥，则必须与之一致。

各客户端的完整字段、工具调用开关、Codex 的 `config.toml` 与三端共用配置、
CC Switch 一键注册命令，全部在 **[docs/CLIENTS.md](docs/CLIENTS.md)**。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型清单 |
| POST | `/v1/chat/completions` | OpenAI 协议，支持 `stream`、多轮、`reasoning_content`、`tools` |
| POST | `/v1/responses` | Responses 协议（Codex CLI），流式事件完整 |
| POST | `/v1/messages` | Anthropic Messages 协议（Claude Code / CC Switch） |
| POST | `/v1/messages/count_tokens` | 粗略 token 估算 |
| GET | `/healthz` | 代理与 kernel 状态（鉴权开关、启用密钥数、提示词来源与校验结果） |
| GET | `/admin` | Web 管理台（仅回环地址） |
| GET | `/admin/api/state` | 管理台数据快照：网关状态、密钥表、统计 |
| POST | `/admin/api/keys` | 新建密钥（支持 `count` 批量） |
| PATCH / DELETE | `/admin/api/keys/:id` | 改名/备注/有效期/启停、删除单把 |
| POST | `/admin/api/keys/bulk` | 批量 `enable` / `disable` / `reset` / `delete` |
| POST | `/admin/api/settings` | 切换鉴权模式 `auto` / `on` / `off` |
| GET | `/admin/api/auth` | 登录态（只读）：状态、到期时间、凭据来源 |

行为约定：

- 流式：标准 `chat.completion.chunk` + `data: [DONE]`，思维链走 `delta.reasoning_content`
- 非流式：聚合后一次返回，同样带 `reasoning_content` 与 `usage`
- 错误：HTTP 4xx/5xx + `{error:{message,type,code}}`；额度不足统一成 `insufficient quota`
- 会话：按 `user` 字段或「首条用户消息」指纹复用 kernel 会话，6 小时 TTL；kernel 侧保留历史

## 安全与合规

- 只监听 `127.0.0.1`；在管理台新建密钥（或设 `TA_API_KEY`）即可要求鉴权，避免同机其他程序白嫖额度
- 密钥表是明文 JSON（`runtime/config/api-keys.json`），只在本机、已在 gitignore 内；
  需要更强隔离可设 `TA_ADMIN_TOKEN`，或按 [docs/CONFIG.md](docs/CONFIG.md) 限制管理台来源
- 管理台仅回环可访问，但仍不建议把 8787 端口通过内网穿透 / 反代暴露出去
- 登录态只在进程内存中出现；含 token 的临时 payload 在 kernel 就绪后立即删除
- 这是**自用**工具：不要对外暴露、不要分发账号额度、不要用于绕过计费。
  与官方客户端相比，请求节奏、system 提示词、工具集合都不同，请自行评估账号风险

## 版本

当前版本 **0.3.3**，变更记录见 [CHANGELOG.md](CHANGELOG.md)。
桌面端升级后协议可能变化，先跑 `npm run doctor`，再按
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 末尾的「桌面端升级排查清单」逐项核对。

## 许可

见 [LICENSE](LICENSE)。
