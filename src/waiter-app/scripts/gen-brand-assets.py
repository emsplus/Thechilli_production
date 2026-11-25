#!/usr/bin/env python3
"""Brand assets for the native shells from the owner's logo (design-system/brand, guide 2026-10-31). Needs Pillow.
- iOS + Android launcher icons: the owner's app icon (white rounded tile with the chilli mark; a red chilli on a red tile would vanish).
- Android adaptive icon: the mark on transparent inside the 66/108 safe zone over a white background (values/ic_launcher_background.xml).
- iOS launch image + Android legacy splash: Chilli Red #E50914 -> Chilli 700 #C20710 gradient with the mark on a white rounded tile,
  the same picture as the web splash (src/components/Splash.tsx), so launch screen -> splash has no jump.
Run: python3 scripts/gen-brand-assets.py [path/to/design-system/brand]"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "../../design-system/brand")
RES = os.path.join(ROOT, "android/app/src/main/res")
IOS = os.path.join(ROOT, "ios/App/App/Assets.xcassets")
TOP, BOTTOM = (0xE5, 0x09, 0x14), (0xC2, 0x07, 0x10)
DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

icon = Image.open(os.path.join(BRAND, "app-icon-1024.png")).convert("RGBA")
mark = Image.open(os.path.join(BRAND, "logo-mark.png")).convert("RGBA")
mark = mark.crop(mark.getbbox())


def fit(img, box):
    k = min(box / img.width, box / img.height)
    return img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)


def centred(canvas, img):
    canvas.alpha_composite(img, ((canvas.width - img.width) // 2, (canvas.height - img.height) // 2))


def splash(size):
    grad = Image.new("RGBA", (1, 256))
    for y in range(256):
        t = y / 255
        grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    cv = grad.resize((size, size), Image.BILINEAR)
    tile = round(size * 0.11)  # 300 pt of 2732 on iOS, the web splash's 132 px badge on a phone
    r = round(tile * 0.3)
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(((size - tile) // 2, (size - tile) // 2 + tile // 12, (size + tile) // 2, (size + tile) // 2 + tile // 12), r, fill=(110, 2, 7, 90))
    cv.alpha_composite(sh.filter(ImageFilter.GaussianBlur(tile // 10)))
    t = Image.new("RGBA", (tile, tile), (0, 0, 0, 0))
    ImageDraw.Draw(t).rounded_rectangle((0, 0, tile - 1, tile - 1), r, fill=(255, 255, 255, 255))
    centred(t, fit(mark, round(tile * 0.82)))
    centred(cv, t)
    return cv.convert("RGB")


# Launcher icons
icon.convert("RGB").save(os.path.join(IOS, "AppIcon.appiconset/AppIcon-512@2x.png"))
for d, k in DENS.items():
    p = os.path.join(RES, f"mipmap-{d}")
    s, f = round(48 * k), round(108 * k)
    ic = icon.resize((s, s), Image.LANCZOS)
    ic.save(os.path.join(p, "ic_launcher.png"))
    m = Image.new("L", (s * 4, s * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, s * 4 - 1, s * 4 - 1), fill=255)
    rnd = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    rnd.paste(ic, mask=m.resize((s, s), Image.LANCZOS))
    rnd.save(os.path.join(p, "ic_launcher_round.png"))
    fg = Image.new("RGBA", (f, f), (0, 0, 0, 0))
    centred(fg, fit(mark, round(f * 0.58)))  # inside the 66/108 safe circle
    fg.save(os.path.join(p, "ic_launcher_foreground.png"))

# Splash images
big = splash(2732)
for n in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
    big.save(os.path.join(IOS, "Splash.imageset", n), optimize=True)
for sub, size in [("drawable", 1200)] + [(f"drawable-{o}-{d}", int(300 * k * 2)) for o in ("port", "land") for d, k in DENS.items()]:
    splash(size).save(os.path.join(RES, sub, "splash.png"), optimize=True)
print("ok")
