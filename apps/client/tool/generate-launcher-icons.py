#!/usr/bin/env python3    """Generate the StrictProxy launcher icon: a lowercase "sp" monogram.

Android needs a bitmap for every density plus an adaptive icon (background colour
+ foreground layer) for Android 8+. Drawing them here rather than committing
hand-made binaries keeps the mark reproducible: change the colours or the font
size below, re-run, and every density stays consistent.

Output goes to the tracked `apps/client/android-host/res`, which
`tool/configure-android-host.sh` copies into the generated Android project. This
script is a development tool: builds do not need Pillow.

Requires Pillow and a bold sans font (DejaVu is present on Debian/Ubuntu and on
the GitHub Actions runner):

    python3 -m pip install pillow
    python3 apps/client/tool/generate-launcher-icons.py

Pass a different resource directory as the first argument if needed.
    """
from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BACKGROUND = (18, 18, 26, 255)      # #12121A, the app's scaffold colour
S_GLYPH = (245, 243, 255, 255)      # #F5F3FF, near-white
P_GLYPH = (167, 139, 250, 255)      # #A78BFA, the app's violet

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]

DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}

# Legacy icon edge length in dp, and the adaptive-icon canvas in dp.
LEGACY_DP = 48
ADAPTIVE_DP = 108


def find_font() -> str:
    override = os.environ.get("ICON_FONT")
    if override:
        return override
    for candidate in FONTS:
        if Path(candidate).is_file():
            return candidate
    raise SystemExit("no bold TTF found; set ICON_FONT=/path/to/font.ttf")


def glyph_layout(font_path: str, size: int):
    """Bounding boxes of "s" and "p" at a font size, with their overlap."""
    font = ImageFont.truetype(font_path, size)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    s_box = probe.textbbox((0, 0), "s", font=font)
    p_box = probe.textbbox((0, 0), "p", font=font)
    overlap = int((s_box[3] - s_box[1]) * 0.06)
    return font, s_box, p_box, overlap


def fit_font(font_path: str, max_width: int, max_height: int) -> int:
    """Largest font size whose "sp" mark fits the given box."""
    low, high = 8, max(16, max_height * 4)
    best = low
    while low <= high:
        mid = (low + high) // 2
        _, s_box, p_box, overlap = glyph_layout(font_path, mid)
        width = (s_box[2] - s_box[0]) + (p_box[2] - p_box[0]) - overlap
        height = max(s_box[3] - s_box[1], p_box[3] - p_box[1])
        if width <= max_width and height <= max_height:
            best = mid
            low = mid + 1
        else:
            high = mid - 1
    return best


def draw_mark(image: Image.Image, font_path: str, max_width: int, max_height: int) -> None:
    draw = ImageDraw.Draw(image)
    size = fit_font(font_path, max_width, max_height)
    font, s_box, p_box, overlap = glyph_layout(font_path, size)

    s_w, s_h = s_box[2] - s_box[0], s_box[3] - s_box[1]
    p_w, p_h = p_box[2] - p_box[0], p_box[3] - p_box[1]
    total_w = s_w + p_w - overlap
    total_h = max(s_h, p_h)

    left = (image.width - total_w) // 2
    top = (image.height - total_h) // 2

    # Offsets remove the glyph's own bearing, so the drawn ink is centred.
    draw.text((left - s_box[0], top - s_box[1]), "s", font=font, fill=S_GLYPH)
    draw.text(
        (left + s_w - overlap - p_box[0], top - p_box[1]),
        "p",
        font=font,
        fill=P_GLYPH,
    )


def legacy_icon(font_path: str, edge: int) -> Image.Image:
    image = Image.new("RGBA", (edge, edge), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = int(edge * 0.22)
    draw.rounded_rectangle([0, 0, edge - 1, edge - 1], radius=radius, fill=BACKGROUND)
    # A hairline violet ring keeps the icon distinct on dark wallpapers.
    inset = max(1, int(edge * 0.035))
    draw.rounded_rectangle(
        [inset, inset, edge - 1 - inset, edge - 1 - inset],
        radius=max(1, radius - inset),
        outline=(124, 77, 255, 120),
        width=max(1, int(edge * 0.012)),
    )
    draw_mark(image, font_path, int(edge * 0.58), int(edge * 0.42))
    return image


def adaptive_foreground(font_path: str, edge: int) -> Image.Image:
    image = Image.new("RGBA", (edge, edge), (0, 0, 0, 0))
    # The safe zone is the middle 66% of the 108dp canvas; the mark stays
    # comfortably inside it so no launcher mask clips it.
    draw_mark(image, font_path, int(edge * 0.46), int(edge * 0.32))
    return image


def main() -> None:
    font_path = find_font()
    # Tracked source assets, not the generated Android tree: `flutter create`
    # recreates `android/` on every clean checkout, so icons written there would
    # never be committed. tool/configure-android-host.sh copies them in.
    res = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parent.parent / "android-host/res"
    )
    if not res.is_dir():
        raise SystemExit(f"resource directory not found: {res}")

    for name, scale in DENSITIES.items():
        target = res / f"mipmap-{name}"
        target.mkdir(parents=True, exist_ok=True)

        edge = round(LEGACY_DP * scale)
        legacy_icon(font_path, edge).save(target / "ic_launcher.png", optimize=True)

        adaptive = round(ADAPTIVE_DP * scale)
        adaptive_foreground(font_path, adaptive).save(
            target / "ic_launcher_foreground.png", optimize=True
        )

    anydpi = res / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    (anydpi / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
        "</adaptive-icon>\n",
        encoding="utf-8",
    )

    values = res / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        '    <color name="ic_launcher_background">#12121A</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )

    print(f"launcher icons written to {res}")


if __name__ == "__main__":
    main()
