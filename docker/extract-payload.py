#!/usr/bin/env python3
"""从 TeleAgent .deb 提取 Linux 内核二进制到 docker/payload/。

用法:
  python extract-payload.py <deb 路径> <输出架构: amd64|arm64>

流程: ar -> data.tar.xz -> opt/TeleAgent/resources/super-agent-code-linux-<arch>.tar.gz
      -> super-agent-code/bin/TeleAgent
不落中间大文件，全程流式。
"""
import io
import lzma
import os
import sys
import tarfile
import hashlib

AR_MAGIC = b"!<arch>\n"
INNER_NAME = {
    "amd64": "super-agent-code-linux-x64.tar.gz",
    "arm64": "super-agent-code-linux-arm64.tar.gz",
}
TARGET_INNER = "super-agent-code/bin/TeleAgent"
EXPECTED_SHA = {
    "amd64": "26f1008b4066c45a1eb5f193261d5aa78f1b4a5dab3c7040d924ec66c4c11b40",
    "arm64": "fd3a5f979305645d5b4ec847762276a5407ad055f735e89a1ae5bdd09aafaffc",
}


def iter_ar(path):
    """产出 (name, size, offset)。deb 的 ar 成员名以 / 结尾。"""
    with open(path, "rb") as f:
        if f.read(8) != AR_MAGIC:
            raise SystemExit("不是 ar 归档")
        while True:
            hdr = f.read(60)
            if len(hdr) < 60:
                return
            name = hdr[0:16].decode("ascii", "replace").strip()
            size = int(hdr[48:58].decode("ascii").strip() or 0)
            data_off = f.tell()
            yield name.rstrip("/"), size, data_off
            f.seek(data_off + size + (size & 1))


class ArMember(io.RawIOBase):
    """把 ar 里某个成员包装成只读文件对象。"""

    def __init__(self, path, offset, size):
        self._f = open(path, "rb")
        self._f.seek(offset)
        self._left = size

    def readable(self):
        return True

    def readinto(self, b):
        if self._left <= 0:
            return 0
        n = min(len(b), self._left)
        chunk = self._f.read(n)
        b[: len(chunk)] = chunk
        self._left -= len(chunk)
        return len(chunk)

    def close(self):
        self._f.close()
        super().close()


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    deb, arch = sys.argv[1], sys.argv[2]
    if arch not in INNER_NAME:
        raise SystemExit(f"不支持的架构: {arch}")

    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "payload")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"TeleAgent-linux-{arch}")

    # 1) 找 data.tar.xz
    data_member = None
    for name, size, off in iter_ar(deb):
        if name.startswith("data.tar"):
            data_member = (name, size, off)
            print(f"[ar] {name}  {size:,} 字节")
        else:
            print(f"[ar] {name}  {size:,} 字节")
    if not data_member:
        raise SystemExit("deb 内无 data.tar.*")

    name, size, off = data_member
    raw = ArMember(deb, off, size)

    # 2) 解压 data.tar.xz 并挑出目标 tar.gz
    print(f"[data] 流式解压 {name} ...")
    if name.endswith(".xz"):
        stream = lzma.open(raw, "rb")
    elif name.endswith(".gz"):
        import gzip

        stream = gzip.GzipFile(fileobj=raw)
    elif name.endswith(".tar"):
        stream = raw
    else:
        raise SystemExit(f"未知压缩: {name}")

    inner_bytes = None
    with tarfile.open(fileobj=stream, mode="r|") as tf:
        for m in tf:
            if not m.isfile():
                continue
            base = os.path.basename(m.name)
            if base == INNER_NAME[arch]:
                print(f"[hit] {m.name}  {m.size:,} 字节")
                inner_bytes = tf.extractfile(m).read()
                break
    if inner_bytes is None:
        raise SystemExit(f"未在 data 中找到 {INNER_NAME[arch]}")
    print(f"[inner] 已取得 {len(inner_bytes):,} 字节")

    # 3) 从 tar.gz 里取内核
    print("[kernel] 解包内层 tar.gz ...")
    with tarfile.open(fileobj=io.BytesIO(inner_bytes), mode="r:gz") as tf:
        target = None
        for m in tf:
            if m.isfile() and m.name.lstrip("./") == TARGET_INNER:
                target = m
                break
        if target is None:
            names = [m.name for m in tf.getmembers()[:10]]
            raise SystemExit(f"内层无 {TARGET_INNER}，前几项: {names}")
        blob = tf.extractfile(target).read()

    h = hashlib.sha256(blob).hexdigest()
    print(f"[sha256] {h}")
    if h != EXPECTED_SHA[arch]:
        print(f"[warn] 与 DEB_ANALYSIS 记录不一致（期望 {EXPECTED_SHA[arch]}）")

    with open(out_path, "wb") as f:
        f.write(blob)
    os.chmod(out_path, 0o755)
    print(f"[done] {out_path}  {len(blob):,} 字节")


if __name__ == "__main__":
    main()
