"""Build responsive WebP sizes for every photo in assets-src/ into public/images/.
Run: python3 scripts/optimize_images.py   (needs Pillow)
Photos are free-to-use Unsplash images; originals live in assets-src/."""
from pathlib import Path
from PIL import Image

SRC, OUT = Path('assets-src'), Path('public/images')
WIDTHS = (640, 960, 1400)
OUT.mkdir(parents=True, exist_ok=True)
for old in OUT.glob('*.webp'):
    old.unlink()
for f in sorted(SRC.glob('*.jpg')):
    im = Image.open(f).convert('RGB')
    for w in WIDTHS:
        if im.width < w:
            continue
        r = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        r.save(OUT / f'{f.stem}-{w}.webp', 'WEBP', quality=74, method=6)
    print(f.stem, im.size)
