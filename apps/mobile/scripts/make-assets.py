#!/usr/bin/env python3
"""G-16 — Android launcher icons and splash screens from the PWA artwork.

    python3 apps/mobile/scripts/make-assets.py            # run from the repo root
    python3 apps/mobile/scripts/make-assets.py --check    # only report what is missing

The PWA already ships `apps/web/public/icons/icon-512.png` (same brand mark the browser
installs), so the launcher icon is a downscale of that one file — one artwork, one place to
change it. Needs Pillow (`pip install pillow`); it is a build-time tool, not a runtime one.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "apps" / "web" / "public" / "icons" / "icon-512.png"
MASKABLE = ROOT / "apps" / "web" / "public" / "icons" / "icon-maskable-512.png"
RES = ROOT / "apps" / "mobile" / "android" / "app" / "src" / "main" / "res"

# Android's density buckets. `ic_launcher` is 48dp, the adaptive foreground is 108dp.
DENSITIES = {
    "mdpi": 1,
    "hdpi": 1.5,
    "xhdpi": 2,
    "xxhdpi": 3,
    "xxxhdpi": 4,
}
SPLASH_BACKGROUND = (11, 15, 20, 255)  # #0B0F14 — UX-SPEC dark background


def sizes() -> list[tuple[str, int, int, int]]:
    out = []
    for name, scale in DENSITIES.items():
        out.append((name, round(48 * scale), round(108 * scale), 0))
    return out


def rounded(source: Image.Image, size: int) -> Image.Image:
    """A circle mask for `ic_launcher_round`; Android crops to a circle on many launchers."""
    scaled = source.resize((size, size), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (size * 4, size * 4), 0)
    from PIL import ImageDraw

    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    scaled.putalpha(mask)
    return scaled


def splash(source: Image.Image, width: int, height: int) -> Image.Image:
    """Brand mark centred on the app background — the same look as the PWA splash."""
    canvas = Image.new("RGBA", (width, height), SPLASH_BACKGROUND)
    mark = round(min(width, height) * 0.28)
    scaled = source.resize((mark, mark), Image.LANCZOS).convert("RGBA")
    canvas.alpha_composite(scaled, ((width - mark) // 2, (height - mark) // 2))
    return canvas


def main() -> int:
    check_only = "--check" in sys.argv
    if not SOURCE.exists():
        print(f"missing source artwork: {SOURCE}", file=sys.stderr)
        return 1

    source = Image.open(SOURCE)
    maskable = Image.open(MASKABLE) if MASKABLE.exists() else source
    written = 0
    missing: list[str] = []

    for density, icon_size, foreground_size, _ in sizes():
        targets = {
            RES / f"mipmap-{density}" / "ic_launcher.png": source.resize(
                (icon_size, icon_size), Image.LANCZOS
            ),
            RES / f"mipmap-{density}" / "ic_launcher_round.png": rounded(source, icon_size),
            RES / f"mipmap-{density}" / "ic_launcher_foreground.png": maskable.resize(
                (foreground_size, foreground_size), Image.LANCZOS
            ),
        }
        for path, image in targets.items():
            if check_only:
                if not path.exists():
                    missing.append(str(path.relative_to(ROOT)))
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            image.convert("RGBA").save(path)
            written += 1

    # One splash per orientation bucket; Capacitor picks the closest match at runtime.
    for density, scale in DENSITIES.items():
        width, height = round(320 * scale), round(480 * scale)
        for folder, size in (
            (f"drawable-port-{density}", (width, height)),
            (f"drawable-land-{density}", (height, width)),
        ):
            path = RES / folder / "splash.png"
            if check_only:
                if not path.exists():
                    missing.append(str(path.relative_to(ROOT)))
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            splash(source, *size).convert("RGB").save(path)
            written += 1

    path = RES / "drawable" / "splash.png"
    if check_only:
        if not path.exists():
            missing.append(str(path.relative_to(ROOT)))
    else:
        splash(source, 480, 480).convert("RGB").save(path)
        written += 1

    if check_only:
        if missing:
            print(f"{len(missing)} android asset(s) missing:")
            for item in missing:
                print(f"  - {item}")
            return 1
        print("all android icons and splashes are present")
        return 0

    print(f"wrote {written} android assets from {SOURCE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
