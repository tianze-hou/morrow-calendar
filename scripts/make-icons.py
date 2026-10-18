"""把 favicon.svg 的几何按位图重画一遍，生成各尺寸 PNG。

为什么不在本地装 rsvg / ImageMagick：这套几何只有圆角矩形和矩形，
用 Pillow 直接画比重开一条工具链省事，也顺带能控制每档尺寸的取样倍数。
"""
import os
from PIL import Image, ImageDraw

BG = (0x16, 0x19, 0x1D, 255)
FG = (0x7B, 0xA0, 0xC8, 255)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
SRC = 64.0


def draw(size: int, rounded: bool, simple: bool = False) -> Image.Image:
    ss = 8 if size <= 192 else 4  # 小图多取样，抗锯齿更干净
    n = size * ss
    k = n / SRC
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def r(*v):
        return tuple(round(x * k) for x in v)

    # 底板：apple-touch-icon 交给 iOS 自己切圆角，这里只在浏览器图标上做圆角
    radius = 14 * k if rounded else 0
    d.rounded_rectangle(r(0, 0, 64, 64), radius=radius, fill=BG)

    # 16–32px 的图标去掉所有内部细节：页眉线与当日标记在这个尺寸下会糊成一团，
    # 只留「粗描边的日历页 + 两个挂环」，缩到 16px 仍能认出是日历。
    if simple:
        d.rounded_rectangle(r(14, 19, 50, 49), radius=4 * k, outline=FG, width=round(5.2 * k))
        for x in (21.8, 37.0):
            d.rounded_rectangle(r(x, 11.0, x + 5.2, 21.0), radius=2.6 * k, fill=FG)
        return img.resize((size, size), Image.LANCZOS)

    sw = max(1, round(4.2 * k))
    d.rounded_rectangle(r(13, 18, 51, 50), radius=4 * k, outline=FG, width=sw)
    for x in (21.4, 38.2):
        d.rounded_rectangle(r(x, 10.6, x + 4.4, 21.0), radius=2.2 * k, fill=FG)
    d.rectangle(r(15.6, 26.6, 48.4, 29.0), fill=FG)
    d.rectangle(r(23.0, 34.0, 31.6, 42.6), fill=FG)

    return img.resize((size, size), Image.LANCZOS)


for name, size, rounded in [
    ('favicon-32.png', 32, True),
    ('apple-touch-icon.png', 180, False),
    ('icon-192.png', 192, True),
    ('icon-512.png', 512, True),
]:
    draw(size, rounded, simple=size <= 32).save(os.path.join(OUT, name))
    print('wrote', name)

# maskable 图标：系统会按自己的形状裁切，图形必须落在中间 80% 的安全区里，
# 所以这里用满版底色 + 缩小一圈的图形。
big = draw(512, rounded=False).convert('RGBA')
inner = big.crop((52, 52, 460, 460)).resize((410, 410), Image.LANCZOS)
mask_bg = Image.new('RGBA', (512, 512), BG)
mask_bg.paste(inner, (51, 51), inner)
mask_bg.save(os.path.join(OUT, 'icon-maskable-512.png'))
print('wrote icon-maskable-512.png')
