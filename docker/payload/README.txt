把官方 Linux 内核二进制放在本目录，供 Dockerfile 按架构选择。

需要两个文件（从对应 deb 包里提取，提取方法见 ../DEPLOY-GUIDE.md 第 3 节）：

  TeleAgent-linux-amd64    ← TeleAgent-3.1.1-amd64.deb 内
                              resources/super-agent-code-linux-x64.tar.gz
                              解包 → super-agent-code/bin/TeleAgent
  TeleAgent-linux-arm64    ← TeleAgent-3.1.1-arm64.deb 内
                              resources/super-agent-code-linux-arm64.tar.gz
                              解包 → super-agent-code/bin/TeleAgent

两个都是静态 ELF，无需附带 .so。
构建时 TARGETARCH=amd64 选前者、=arm64 选后者；两种架构用同一份 Dockerfile。

sha256（实测，供下载后核对）：

  38d0faee9c471f403511c4a6e0c46dcce950da544bb530986f7282815c4c3a9d
    super-agent-code-linux-x64.tar.gz
  26f1008b4066c45a1eb5f193261d5aa78f1b4a5dab3c7040d924ec66c4c11b40
    解包后的 TeleAgent(x64) = TeleAgent-linux-amd64

  5bfa6ff4b060e5ae6cb633bb59b8a39a8d71458611d556327a79f00d7b287938
    super-agent-code-linux-arm64.tar.gz
  fd3a5f979305645d5b4ec847762276a5407ad055f735e89a1ae5bdd09aafaffc
    解包后的 TeleAgent(arm64) = TeleAgent-linux-arm64
