"""Render the Quant Gold weekly results as a Telegram-ready PNG."""

import argparse
from decimal import Decimal
from math import exp
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT = 1080, 720
GOLD = "#F4CD78"
WHITE = "#F3F6F5"
MUTED = "#B4C4C8"

FONT_PAIRS = (
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
)


def select_fonts():
    for regular, bold in FONT_PAIRS:
        if Path(regular).is_file() and Path(bold).is_file():
            return regular, bold
    raise RuntimeError("Install DejaVu Sans or Liberation Sans to render the card.")


def background():
    width, height = WIDTH // 6, HEIGHT // 6
    pixels = []
    for y in range(height):
        for x in range(width):
            u, v = x / width, y / height
            teal = exp(-(((u - 0.80) / 0.43) ** 2 + ((v - 0.02) / 0.59) ** 2))
            warm = exp(-(((u - 0.13) / 0.54) ** 2 + ((v - 1.13) / 0.40) ** 2))
            pixels.append((round(8 + 8 * teal + 17 * warm), round(15 + 34 * teal + 11 * warm), round(23 + 34 * teal + 4 * warm)))

    image = Image.new("RGB", (width, height))
    image.putdata(pixels)
    return image.resize((WIDTH, HEIGHT), Image.Resampling.BICUBIC)


def tracked_label(draw, xy, label, font, fill):
    x, y = xy
    for letter in label:
        draw.text((x, y), letter, font=font, fill=fill, anchor="ls")
        x += font.getlength(letter) + 2.8


def fit_text(draw, xy, text, font_path, size, max_width, fill):
    font = ImageFont.truetype(font_path, size)
    while font.getlength(text) > max_width and size > 1:
        size -= 1
        font = ImageFont.truetype(font_path, size)
    draw.text(xy, text, font=font, fill=fill, anchor="ls")


def render(period, performance, trades, output, sample=False):
    plain, bold = select_fonts()
    label_font = ImageFont.truetype(bold, 21)

    image = background()
    draw = ImageDraw.Draw(image)

    for offset in (0, 23, 46):
        draw.arc((714 - offset, -226 - offset, 1247 + offset, 318 + offset), 60, 180, fill="#275057", width=1)

    draw.rounded_rectangle((63, 65, 99, 69), radius=2, fill=GOLD)
    tracked_label(draw, (116, 75), "TRIX TREND", label_font, GOLD)
    if sample:
        draw.rounded_rectangle((878, 48, 1017, 88), radius=20, fill="#213438", outline="#436063", width=1)
        draw.text((947, 68), "SAMPLE", font=label_font, fill=GOLD, anchor="mm")

    draw.text((62, 181), "Quant Gold", font=ImageFont.truetype(bold, 80), fill=WHITE, anchor="ls")
    draw.text((65, 238), "Weekly results", font=ImageFont.truetype(plain, 32), fill=MUTED, anchor="ls")
    period_font = ImageFont.truetype(plain, 28)
    if period_font.getlength(period) > 610:
        raise ValueError("The display period is too long for the card.")
    draw.text((1016, 238), period, font=period_font, fill=WHITE, anchor="rs")

    draw.rounded_rectangle((63, 285, 1017, 594), radius=29, fill="#121F27", outline="#375058", width=2)
    draw.line((637, 336, 637, 535), fill="#375058", width=2)
    tracked_label(draw, (106, 367), "WEEKLY RETURN", label_font, MUTED)
    tracked_label(draw, (684, 367), "CLOSED TRADES", label_font, MUTED)

    result = Decimal(performance[:-1])
    result_color = GOLD if result > 0 else "#F2A6A1" if result < 0 else WHITE
    display_result = performance.replace("-", "−", 1)
    as_text = f"{trades:,}"
    fit_text(draw, (101, 524), display_result, bold, 118, 495, result_color)
    fit_text(draw, (678, 524), as_text, bold, 112, 296, WHITE)

    footer_font = ImageFont.truetype(plain, 22)
    draw.text((64, 661), "TRIXTREND.COM", font=ImageFont.truetype(bold, 22), fill=GOLD, anchor="ls")
    draw.text((1017, 661), "Past performance does not guarantee future results.", font=footer_font, fill=MUTED, anchor="rs")

    image.save(output, format="PNG", optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--period", required=True)
    parser.add_argument("--performance", required=True, help="For example, --performance=+1.29%% or --performance=-1.29%%")
    parser.add_argument("--trades", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sample", action="store_true", help="Mark the card as a sample")
    args = parser.parse_args()

    if not args.period.strip() or not re.fullmatch(r"[+-]?[0-9]{1,10}\.[0-9]{2}%", args.performance) or args.trades < 0:
        parser.error("Provide a period, a percentage with two decimal places, and a non-negative trade count.")

    render(args.period, args.performance, args.trades, args.output, args.sample)


if __name__ == "__main__":
    main()
