#!/usr/bin/env python3
"""从 TeleAgent .deb 里取出 app.asar，并列出/导出其中的 JS 文件。

用法:
  python extract-asar.py list  <deb>            # 列出 asar 内所有文件与大小
  python extract-asar.py find  <deb> <关键词>   # 找出解压后内容含关键词的 JS 文件
  python extract-asar.py dump  <deb> <内部路径> <输出文件>

流程: ar -> data.tar.xz -> opt/TeleAgent/resources/app.asar -> asar header 解析
"""
import io
import json
import lzma
import os
import struct
import sys
import tarfile
import tempfile

AR_MAGIC = b"!<arch>\n"
ASAR_INNER = "TeleAgent/resources/app.asar"


def iter_ar(path):
    with open(path, "rb") as f:
        if f.read(8) != AR_MAGIC:
            raise SystemExit("不是 ar 归档")
        while True:
            hdr = f.read(60)
            if len(hdr) < 60:
                return
            name = hdr[0:16].decode("ascii", "replace").strip().rstrip("/")
            size = int(hdr[48:58].decode("ascii").strip() or 0)
            data_off = f.tell()
            yield name, size, data_off
            f.seek(data_off + size + (size & 1))


class ArMember(io.RawIOBase):
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


def get_asar(deb, cache="/tmp/TA2API-app.asar"):
    if os.path.exists(cache) and os.path.getsize(cache) > 1_000_000:
        return cache
    print(f"[*] 从 {deb} 提取 {ASAR_INNER} …", flush=True)
    for name, size, off in iter_ar(deb):
        if not name.startswith("data.tar"):
            continue
        print(f"[*] 读到成员 {name} ({size/1e6:.0f} MB)", flush=True)
        raw = ArMember(deb, off, size)
        opener = lzma.open if name.endswith(".xz") else None
        stream = opener(raw) if opener else raw
        with tarfile.open(fileobj=stream, mode="r|") as tf:
            for m in tf:
                if m.name.endswith(ASAR_INNER):
                    print(f"[*] 命中 {m.name} ({m.size/1e6:.0f} MB)，写出中…", flush=True)
                    with open(cache, "wb") as out:
                        src = tf.extractfile(m)
                        while True:
                            b = src.read(1 << 20)
                            if not b:
                                break
                            out.write(b)
                    return cache
        raise SystemExit("data.tar 里没找到 app.asar")
    raise SystemExit("deb 里没有 data.tar 成员")


def read_header(asar):
    with open(asar, "rb") as f:
        pre = f.read(16)
        if len(pre) < 16:
            raise SystemExit("asar 文件太小")
        header_size = struct.unpack("<I", pre[12:16])[0]
        raw = f.read(header_size)
    header = json.loads(raw.decode("utf-8"))
    base = 16 + header_size
    # 4 字节对齐
    if base % 4:
        base += 4 - (base % 4)
    return header, base


def walk(node, prefix=""):
    for name, info in (node.get("files") or {}).items():
        p = f"{prefix}/{name}" if prefix else name
        if "files" in info:
            yield from walk(info, p)
        else:
            yield p, info


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    cmd, deb = sys.argv[1], sys.argv[2]
    asar = get_asar(deb)
    header, base = read_header(asar)
    entries = list(walk(header))
    print(f"[*] asar 内 {len(entries)} 个文件，内容起始偏移 {base}", flush=True)

    if cmd == "list":
        for p, info in sorted(entries, key=lambda x: -x[1].get("size", 0))[:40]:
            print(f"{info.get('size', 0):>12,}  {p}")
        return

    if cmd == "find":
        kw = sys.argv[3].encode()
        hits = []
        for p, info in entries:
            if not p.endswith((".js", ".mjs", ".cjs")):
                continue
            size = info.get("size", 0)
            if not size:
                continue
            off = info.get("offset")
            if off is None:
                continue
            with open(asar, "rb") as f:
                f.seek(base + int(off))
                blob = f.read(size)
            if kw in blob:
                hits.append((p, size))
        for p, size in sorted(hits, key=lambda x: -x[1]):
            print(f"{size:>12,}  {p}")
        print(f"[*] 命中 {len(hits)} 个文件", flush=True)
        return

    if cmd == "dump":
        target, out = sys.argv[3], sys.argv[4]
        for p, info in entries:
            if p == target:
                off = int(info["offset"])
                with open(asar, "rb") as f:
                    f.seek(base + off)
                    blob = f.read(info["size"])
                with open(out, "wb") as o:
                    o.write(blob)
                print(f"[*] 写出 {out} ({len(blob):,} 字节)")
                return
        raise SystemExit("未找到该内部路径")


if __name__ == "__main__":
    main()
