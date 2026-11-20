#!/bin/sh
# TA2API 容器入口：把账号配置文件与官方 Linux 内核摆到 paths.mjs 期望的位置。
#
# 自给自足流程（推荐）：
#   1. 把 PC 端「非密」配置拷到 /data/TeleAgent（current-owner.json、.version.json、
#      users/<ownerDir>/model-catalog.json 与 preset-context.json）
#   2. 容器启动后浏览器打开管理台 → 「打开登录页」完成一次登录（或粘贴回跳网址）
#   3. 凭据存放在 /app/runtime/credentials/（挂载卷持久化），之后每天自动续期
#
# 离线迁移流程（可选）：PC 跑 docker/export-credentials.mjs，把产物 credentials/
# 拷到 /app/runtime/credentials/，无需在 NAS 上登录。
set -eu

DATA_ROOT="${TA_DATA_ROOT:-/data}"
LAYOUT_ROOT="$DATA_ROOT/TeleAgent"        # 账号配置布局（不含密钥也可启动）
HOME_DATA="/root/.local/share/TeleAgent"
HOME_CONF="/root/.config/TeleAgent"

mkdir -p "$HOME_DATA" "$HOME_CONF" "$HOME_DATA/runtimes" \
         /app/runtime/data /app/runtime/config /app/runtime/cache \
         /app/runtime/logs /app/runtime/tmp /app/runtime/credentials

# 1) 账号配置根：让 paths.mjs 的默认 ~/.local/share/TeleAgent 落到挂载卷
#    （current-owner.json / .version.json / users/<ownerDir>/model-catalog.json 等）
if [ -d "$LAYOUT_ROOT" ]; then
  rm -rf "$HOME_DATA"
  ln -s "$LAYOUT_ROOT" "$HOME_DATA"
else
  echo "[entrypoint] 缺少 $LAYOUT_ROOT —— 请先放置账号配置文件（见 DEPLOY-GUIDE.md 第 2 节）" >&2
  exit 1
fi

# 2) 内核二进制：paths.mjs 期望 <data_root>/runtimes/super-agent-code/bin/TeleAgent
#    Linux 上文件名不带 .exe，与 deb 解包产物完全一致。
KDIR="$LAYOUT_ROOT/runtimes/super-agent-code/bin"
mkdir -p "$KDIR"
cp -f /opt/teleagent/TeleAgent "$KDIR/TeleAgent"
chmod 0755 "$KDIR/TeleAgent"

# 3) 网关 key：从 secret 文件读进 env，不写进镜像/仓库
if [ -n "${TA_GATEWAY_KEY_FILE:-}" ] && [ -f "$TA_GATEWAY_KEY_FILE" ]; then
  TA_GATEWAY_KEY="$(cat "$TA_GATEWAY_KEY_FILE")"
  export TA_GATEWAY_KEY
fi

# 4) 凭据库提示（非强制）：没有 store.json 也能启动——管理台登录后自动生成
if [ ! -f /app/runtime/credentials/store.json ]; then
  echo "[entrypoint] 尚无凭据库（/app/runtime/credentials/store.json）——启动后请在管理台完成登录"
fi

echo "[entrypoint] 配置根=$LAYOUT_ROOT 内核=$KDIR/TeleAgent 架构=$(uname -m)"
exec "$@"
