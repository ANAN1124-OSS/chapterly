# 章回 / Chapterly 应用图标生成器
# 纯标准库，不依赖 Pillow。用法：python make-icon.py [输出目录]
#
# 图形：外层朱印圆角方 + 纸白「回」字（外圈环 + 内口实心块）
# 几何基准：240×240 网格，与设计稿完全一致
# 小尺寸做光学补偿：<=16 / 24 / 32 / 48 逐级加粗笔画并放大内口，保证 16px 仍可辨认

import os
import struct
import sys
import zlib

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SQUARE = 240.0
RADIUS = 28.0
PAPER = (251, 249, 243)
RED = (143, 58, 40)

# 标准尺寸：16/24/32/48/64/128/256 进 .ico，512 另外出 PNG
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]


def lerp(a, b, t):
    return a + (b - a) * t


# 小尺寸光学表：(外圈起, 外圈止, 笔画, 内口起, 内口止)，单位是 240 网格
# 内口起 > 内口止 表示该尺寸不出内口（16px 只留一个白方框，四个白带在 16px 上必糊）
OPTICAL = {
    16: (46.0, 194.0, 30.0, 1.0, 0.0),
    20: (46.0, 194.0, 26.0, 1.0, 0.0),
    24: (46.0, 194.0, 22.0, 88.0, 152.0),
    32: (46.0, 194.0, 21.0, 87.0, 153.0),
    48: (45.0, 195.0, 20.0, 88.0, 152.0),
}
BASE_GEOM = (44.0, 196.0, 20.0, 88.0, 152.0)


def geom(size):
    """返回 (外圈起点, 外圈终点, 笔画, 内口起点, 内口终点)，单位是 240 网格。"""
    return OPTICAL.get(size, BASE_GEOM)


def supersample(size):
    if size <= 24:
        return 8
    if size <= 32:
        return 6
    if size <= 64:
        return 4
    if size <= 256:
        return 3
    return 2


def render(size):
    """返回 size×size 的 RGBA bytes 列表（每行一条）。"""
    o0, o1, st, b0, b1 = geom(size)
    rl, rh = o0 - st / 2.0, o1 + st / 2.0
    hl, hh = o0 + st / 2.0, o1 - st / 2.0
    ss = supersample(size)
    inv = 1.0 / (ss * ss)
    k = SQUARE / size
    rr = RADIUS * RADIUS
    lim = SQUARE - RADIUS
    pr, pg, pb = PAPER
    cr, cg, cb = RED

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            ar = ag = ab = aa = 0
            for sy in range(ss):
                y = (py + (sy + 0.5) / ss) * k
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * k
                    if b0 <= x <= b1 and b0 <= y <= b1:
                        ar += pr
                        ag += pg
                        ab += pb
                        aa += 255
                        continue
                    if rl <= x <= rh and rl <= y <= rh:
                        if not (hl <= x <= hh and hl <= y <= hh):
                            ar += pr
                            ag += pg
                            ab += pb
                            aa += 255
                            continue
                    cx = RADIUS if x < RADIUS else (lim if x > lim else x)
                    cy = RADIUS if y < RADIUS else (lim if y > lim else y)
                    dx = x - cx
                    dy = y - cy
                    if dx * dx + dy * dy <= rr:
                        ar += cr
                        ag += cg
                        ab += cb
                        aa += 255
            row += bytes(
                (int(ar * inv + 0.5), int(ag * inv + 0.5), int(ab * inv + 0.5), int(aa * inv + 0.5))
            )
        rows.append(bytes(row))
    return rows


def png_bytes(width, height, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def dib_bytes(size, rows):
    """32 位 BMP 帧（ICO 内嵌格式，不含 BITMAPFILEHEADER）。老工具与 NSIS 都认这个。"""
    w = h = size
    mask_row = ((w + 31) // 32) * 4
    mask_size = mask_row * h
    hdr = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4 + mask_size, 0, 0, 0, 0)
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        row = rows[y]
        for x in range(w):
            i = x * 4
            xor += bytes((row[i + 2], row[i + 1], row[i], row[i + 3]))
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = rows[y]
        bits = bytearray(mask_row)
        for x in range(w):
            if row[x * 4 + 3] < 128:
                bits[x >> 3] |= 0x80 >> (x & 7)
        mask += bits
    return hdr + bytes(xor) + bytes(mask)


def ico_bytes(items):
    """items: [(size, blob)]。小于 256 用 BMP 帧，256 用 PNG 帧。"""
    n = len(items)
    offset = 6 + 16 * n
    head = struct.pack("<HHH", 0, 1, n)
    entries = b""
    body = b""
    for size, blob in items:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        body += blob
    return head + entries + body


def blit(dst, dw, dh, src, sw, sh, ox, oy, bg=None):
    """把 RGBA 源图合成到目标行列表上（alpha over）。"""
    for y in range(sh):
        ty = oy + y
        if ty < 0 or ty >= dh:
            continue
        srow = src[y]
        drow = dst[ty]
        for x in range(sw):
            tx = ox + x
            if tx < 0 or tx >= dw:
                continue
            sa = srow[x * 4 + 3]
            if sa == 0:
                continue
            di = tx * 4
            if sa == 255:
                drow[di] = srow[x * 4]
                drow[di + 1] = srow[x * 4 + 1]
                drow[di + 2] = srow[x * 4 + 2]
                drow[di + 3] = 255
            else:
                a = sa / 255.0
                for c in range(3):
                    drow[di + c] = int(srow[x * 4 + c] * a + drow[di + c] * (1 - a) + 0.5)
                drow[di + 3] = 255


def sheet(sizes, bg, gap, margin, path):
    w = margin * 2 + sum(sizes) + gap * (len(sizes) - 1)
    h = max(sizes) + margin * 2
    rows = [bytearray(bytes(bg) * w) for _ in range(h)]
    x = margin
    for s in sizes:
        img = render(s)
        blit(rows, w, h, img, s, s, x, h - margin - s, bg)
        x += s + gap
    with open(path, "wb") as f:
        f.write(png_bytes(w, h, [bytes(r) for r in rows]))


README = """章回 / Chapterly —— Windows 图标全套
=====================================

文件说明
--------
章回.ico           多尺寸图标（16/24/32/48/64/128/256），Windows 下用这个
icon.ico            同上，同名副本；直接覆盖到项目 chapterly\\build\\icon.ico 即可
章回-16.png 起      各尺寸单张 PNG，16~512
预览-纸底.png       全部尺寸摆在纸色底上的对照图
预览-暗底.png       深色底上的对照图（看夜间任务栏效果）
make-icon.py        生成脚本，纯标准库、不需要装 Pillow

设计
----
朱印 #8f3a28 圆角方 + 纸白 #fbf9f3「回」字。
外层口是整本书，内层口是正在写的这一章；图标版把小尺寸的内口收成实心块，
否则 16px 上最先糊掉的是那圈细线。

小尺寸做光学补偿：16/24/32/48 各自一套几何，不是等比缩放。
16px 不出内口、只留一个白方框——四条白带挤在 16px 上一定糊。

重新生成
--------
在本文件夹里打开终端：

    python make-icon.py

会在当前目录重写全部图标。也可以指定别的输出目录：

    python make-icon.py "D:\某个目录"

只重新生成安装包用的图标（icon.ico + icon.png，不写 PNG 单图 / 预览 / 说明）：

    python make-icon.py --ico-only build
"""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ico_only = "--ico-only" in sys.argv[1:]
    default_out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")
    out = args[0] if args else default_out
    os.makedirs(out, exist_ok=True)

    cache = {}
    for s in sorted(set(ICO_SIZES + PNG_SIZES)):
        cache[s] = png_bytes(s, s, render(s))
        if s in PNG_SIZES and not ico_only:
            with open(os.path.join(out, "章回-%d.png" % s), "wb") as f:
                f.write(cache[s])

    ico = ico_bytes(
        [
            (s, cache[s] if s >= 256 else dib_bytes(s, render(s)))
            for s in ICO_SIZES
        ]
    )
    ico_names = ("icon.ico",) if ico_only else ("章回.ico", "icon.ico")
    for name in ico_names:
        with open(os.path.join(out, name), "wb") as f:
            f.write(ico)

    with open(os.path.join(out, "icon.png"), "wb") as f:
        f.write(cache[512])
    if ico_only:
        print("[ok] 已生成:", os.path.join(out, "icon.ico"), os.path.join(out, "icon.png"))
        return

    sheet([16, 24, 32, 48, 64, 128, 256], (239, 236, 228, 255), 48, 72,
          os.path.join(out, "预览-纸底.png"))
    sheet([16, 24, 32, 48, 64, 128, 256], (29, 27, 23, 255), 48, 72,
          os.path.join(out, "预览-暗底.png"))

    with open(os.path.join(out, "说明.txt"), "w", encoding="utf-8") as f:
        f.write(README)

    src = os.path.abspath(__file__)
    dst = os.path.join(out, "make-icon.py")
    if os.path.abspath(dst) != src:
        with open(src, "rb") as f:
            data = f.read()
        with open(dst, "wb") as f:
            f.write(data)

    print("[ok] 输出目录:", out)
    for s in PNG_SIZES:
        print("    章回-%d.png" % s)
    print("    章回.ico / icon.ico (%s)" % ",".join(str(s) for s in ICO_SIZES))
    print("    预览-纸底.png / 预览-暗底.png / 说明.txt / make-icon.py")


if __name__ == "__main__":
    main()

