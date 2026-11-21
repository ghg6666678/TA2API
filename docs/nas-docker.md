# NAS / Docker 部署（已归档）

> 本文件记录的是 v0.7.x 时期的设计稿：双容器（`gateway` + `renew`）、GHCR 多架构镜像、
> `TA_REQUIRE_AUTH` 强制鉴权、容器内自管续期。**这些都没有按原样实现**，其中
> 「容器内自动续期」已被实测证伪。不要照这篇去配 `renew` 容器或 `TA_REQUIRE_AUTH`——
> 这两个东西在当前代码里不存在。

## 现在实际可用的东西

Docker 交付物见 [`../docker/DEPLOY-GUIDE.md`](../docker/DEPLOY-GUIDE.md)：单容器、本地构建、
管理台登录、双卷持久化。

实测通过：

- 三协议端点（chat / responses / messages）+ 工具中继闭环
- 内核看门狗自愈：容器内 `kill -9` 内核后约 11 秒自动复活
- 局域网访问（`TA_HOST=0.0.0.0`）
- 卷持久化（`teleagent.db`、密钥表、凭据、内核日志）

## 实测不可行的部分

**容器内 token 换发**。服务端只接受官方桌面客户端发出的换发请求：用桌面版刚换发产出的
最新凭据（token、`operToken`、`deviceId`、各项头部全部核对过），在 Node fetch、
curl 8.21（Schannel）、Edge/Chromium 131 三种客户端上重放，一律返回
`40115 session not found`；而同一时刻桌面版自己换发是成功的。

已排除：凭据过期、Cookie 未轮转、`deviceId` 不匹配、UA/版本号、双客户端竞争、
会话一次性消费。详见 `docker/DEPLOY-GUIDE.md` 2.3 的完整对照表。

## 所以 NAS 的现实方案

1. **每 7 天导入一次凭据**（token TTL 为 7 天）：在 PC 桌面版登录后
   `node docker/export-credentials.mjs` 导出，或直接在管理台「用 Cookie 登录」粘贴
   `operationToken`（更省事，不用拷文件）。管理台会在剩余 2 天内提示更新。
2. 或者在 PC 上跑反代（`gui` 模式，跟随桌面版 token 更新），不追求 NAS 常驻。

## 保留这份文件的理由

原设计里的数据目录布局（`Local State` / `users/<scope>/app-auth/` / partition Cookies）、
卷划分、首次登录流程仍有参考价值。原始设计稿已备份在项目外
（`TA2API-docs-原始设计稿`），实现细节以 `docker/DEPLOY-GUIDE.md` 为准。
