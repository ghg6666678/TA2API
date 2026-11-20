# syntax=docker/dockerfile:1
# 同一份 Dockerfile 支持 x86_64 与 ARM64：BuildKit 的 TARGETARCH 自动选内核。
# 内核为静态 ELF，不需要 GTK/GLIBC/桌面库。Node 仅用于跑 TA2API 代理本体。
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini coreutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY lib ./lib
COPY web ./web
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# 按构建架构挑内核。两个文件都由 docker/payload/ 提供（见 DEPLOY-GUIDE.md 第 3 节）。
# amd64 -> TeleAgent-linux-amd64；arm64 -> TeleAgent-linux-arm64
ARG TARGETARCH
COPY docker/payload/TeleAgent-linux-${TARGETARCH} /opt/teleagent/TeleAgent
RUN chmod 0755 /opt/teleagent/TeleAgent && \
    sha256sum /opt/teleagent/TeleAgent

ENV TA_HOST=0.0.0.0 \
    TA_PORT=8787 \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.mjs"]
