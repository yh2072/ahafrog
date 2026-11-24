# =============================================================================
# EdGameClaw — AI Game-Based Learning Studio
# Created by Yuqi Hang (github.com/yh2072)
# https://github.com/yh2072/edgameclaw
# =============================================================================
"""Derive a light palette for every theme from its dark one.

Hand-writing 24 light palettes would drift: each would be someone's guess at
the same decisions, and nothing would guarantee the text is readable. Instead
each colour is transformed by the *role* it plays — surface, text, accent,
border, glow — keeping the theme's hue identity, and then every text/background
pair is checked against WCAG and nudged along the lightness axis until it
passes. A light theme lives or dies on contrast; inverting a dark palette
directly puts `muted` (#c080a0 and friends) at about 2:1 on white, which is
unreadable.
"""

from __future__ import annotations

import colorsys
import re

#: Minimum contrast for body text against its background (WCAG AA).
MIN_TEXT_CONTRAST = 4.5
#: Secondary text may sit lower, but not below AA for large text.
MIN_MUTED_CONTRAST = 4.0
#: Borders and dividers only need to be visible, not readable.
MIN_BORDER_CONTRAST = 1.6

_HEX = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_RGBA = re.compile(r"^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$")


# ── colour plumbing ──────────────────────────────────────────────────────────

def _parse(value: str) -> tuple[tuple[float, float, float], float | None]:
    """Return ((r, g, b) in 0..1, alpha or None) for a hex or rgba() string."""
    value = value.strip()
    match = _HEX.match(value)
    if match:
        digits = match.group(1)
        if len(digits) == 3:
            digits = "".join(c * 2 for c in digits)
        return tuple(int(digits[i:i + 2], 16) / 255 for i in (0, 2, 4)), None  # type: ignore[return-value]
    match = _RGBA.match(value)
    if match:
        r, g, b = (float(match.group(i)) / 255 for i in (1, 2, 3))
        alpha = float(match.group(4)) if match.group(4) is not None else None
        return (r, g, b), alpha
    raise ValueError(f"unsupported colour: {value!r}")


def _hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in rgb)


def _rgba(rgb: tuple[float, float, float], alpha: float) -> str:
    r, g, b = (max(0, min(255, round(c * 255))) for c in rgb)
    return f"rgba({r},{g},{b},{round(alpha, 3)})"


def _relative_luminance(rgb: tuple[float, float, float]) -> float:
    def channel(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    """WCAG contrast ratio between two opaque colours."""
    la = _relative_luminance(_parse(a)[0])
    lb = _relative_luminance(_parse(b)[0])
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def _remap(value: str, *, lightness: float, saturation: float | None = None,
           alpha_scale: float | None = None) -> str:
    """Rebuild a colour at a new lightness, keeping its hue."""
    rgb, alpha = _parse(value)
    h, _l, s = colorsys.rgb_to_hls(*rgb)
    new_s = s if saturation is None else max(0.0, min(1.0, saturation))
    out = colorsys.hls_to_rgb(h, max(0.0, min(1.0, lightness)), new_s)
    if alpha is not None:
        return _rgba(out, alpha if alpha_scale is None else max(0.0, min(1.0, alpha * alpha_scale)))
    return _hex(out)


def _darken_until(colour: str, background: str, minimum: float) -> str:
    """Walk a colour darker until it meets a contrast ratio on `background`.

    The lightness axis is the only one that moves: hue and saturation carry the
    theme's identity, so changing them to win contrast would make every light
    theme look the same.
    """
    rgb, alpha = _parse(colour)
    h, l, s = colorsys.rgb_to_hls(*rgb)
    for _ in range(100):
        candidate = colorsys.hls_to_rgb(h, l, s)
        probe = _hex(candidate)
        if contrast(probe, background) >= minimum or l <= 0.02:
            return _rgba(candidate, alpha) if alpha is not None else probe
        l -= 0.01
    return _hex(colorsys.hls_to_rgb(h, 0.02, s))


# ── role-aware derivation ────────────────────────────────────────────────────

#: Each key's role decides how it transforms. Surfaces rise to near-white with
#: a trace of the theme hue; text falls; accents move to a value that works on
#: paper and can still carry white ink.
_SURFACES = {
    "bg": (0.965, 0.42), "containerBg": (0.995, 0.30),
    "cardBg": (0.945, 0.40), "cardHover": (0.905, 0.46), "dotBg": (0.885, 0.38),
    "buttonBg": (0.915, 0.50), "buttonHover": (0.855, 0.58),
}
_BORDERS = {"border": (0.845, 0.34), "inputBorder": (0.760, 0.42),
            "slotBorder": (0.780, 0.40), "dialogBorder": (0.700, 0.50)}
_TEXTS = {"text": (0.185, 0.30), "cardText": (0.255, 0.28), "highlight": (0.300, 0.62)}
_MUTED = {"muted": (0.430, 0.30), "dimText": (0.470, 0.26), "placeholder": (0.530, 0.24)}
_ACCENTS = {"accent": (0.395, 0.70), "success": (0.330, 0.60)}
_GLOWS = {"glow": (0.620, 0.55, 1.4), "glowSoft": (0.700, 0.45, 0.55),
          "glowAccent": (0.520, 0.65, 0.55)}
_TINTS = {"successBg": (0.470, 0.55, 1.0), "errorBg": (0.470, 0.60, 1.0)}


def to_light(dark: dict[str, str]) -> dict[str, str]:
    """Derive a readable light palette from a theme's dark palette."""
    light: dict[str, str] = {}

    for key, (lightness, sat) in {**_SURFACES, **_BORDERS}.items():
        if key in dark:
            light[key] = _remap(dark[key], lightness=lightness, saturation=sat)

    # dialogBg keeps its translucency so the dialogue still floats.
    if "dialogBg" in dark:
        light["dialogBg"] = _remap(dark["dialogBg"], lightness=0.985, saturation=0.35)

    for key, (lightness, sat) in {**_TEXTS, **_MUTED, **_ACCENTS}.items():
        if key in dark:
            light[key] = _remap(dark[key], lightness=lightness, saturation=sat)

    for key, (lightness, sat, alpha_scale) in {**_GLOWS, **_TINTS}.items():
        if key in dark:
            light[key] = _remap(dark[key], lightness=lightness, saturation=sat,
                                alpha_scale=alpha_scale)

    # Anything the role map does not know about keeps its original value rather
    # than silently vanishing from the palette.
    for key, value in dark.items():
        light.setdefault(key, value)

    # ── contrast pass ────────────────────────────────────────────────────────
    page, panel = light["bg"], light.get("containerBg", light["bg"])
    card = light.get("cardBg", page)

    for key, floor, background in (
        ("text", MIN_TEXT_CONTRAST, page),
        ("highlight", MIN_TEXT_CONTRAST, panel),
        ("cardText", MIN_TEXT_CONTRAST, card),
        ("muted", MIN_MUTED_CONTRAST, page),
        ("dimText", MIN_MUTED_CONTRAST, page),
        ("placeholder", 3.0, page),
        ("accent", MIN_TEXT_CONTRAST, page),
        ("success", MIN_TEXT_CONTRAST, page),
        ("border", MIN_BORDER_CONTRAST, page),
        ("inputBorder", 2.0, page),
        ("dialogBorder", 2.0, panel),
    ):
        if key in light:
            light[key] = _darken_until(light[key], background, floor)

    return light


def audit(dark: dict[str, str]) -> list[tuple[str, str, float]]:
    """Report (pair, verdict, ratio) for a derived light palette."""
    light = to_light(dark)
    page = light["bg"]
    checks = [
        ("text on bg", light["text"], page, MIN_TEXT_CONTRAST),
        ("muted on bg", light["muted"], page, MIN_MUTED_CONTRAST),
        ("accent on bg", light["accent"], page, MIN_TEXT_CONTRAST),
        ("highlight on panel", light["highlight"], light.get("containerBg", page), MIN_TEXT_CONTRAST),
        ("cardText on card", light["cardText"], light.get("cardBg", page), MIN_TEXT_CONTRAST),
        ("border on bg", light["border"], page, MIN_BORDER_CONTRAST),
    ]
    return [(name, "ok" if contrast(fg, bg) >= floor else "FAIL", round(contrast(fg, bg), 2))
            for name, fg, bg, floor in checks]
