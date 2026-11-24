#!/usr/bin/env python3
# =============================================================================
# EdGameClaw — AI Game-Based Learning Studio
# Created by Yuqi Hang (github.com/yh2072)
# https://github.com/yh2072/edgameclaw
# =============================================================================
"""Apply the current engine presentation to games that were already generated.

Every generated game is a self-contained index.html with the engine template
baked in, so editing engine/template.html only changes games made *after* the
edit. Regenerating instead would re-run the whole model pipeline and cost real
credits for art and code that are already correct — this rewrites only the
presentation layer of the finished files.

What it changes, per game:
  * replaces the injected presentation block (idempotent: re-run to update)
  * makes the pixel-pack runtime available (no dialogue skin: see template.html)
  * removes the share button, share link and share dialog
  * lifts the scale cap so the stage fills the viewport instead of sitting at
    768x576 in the middle of a large screen

Content, art, dialogue, minigames and saved progress are untouched.

    python tools/restyle_games.py            # every course under courses/
    python tools/restyle_games.py --dry-run
    python tools/restyle_games.py courses/course-123
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "edgameclaw" / "generator"))

START = "/* EDGC-RESTYLE-START */"
END = "/* EDGC-RESTYLE-END */"


def _drop_element(html: str, opening: str) -> str:
    """Remove one element and exactly its own subtree.

    A regex cannot do this. `<div id="x">.*?</div></div></div>` looks like it
    closes three levels, but a lazy match only promises to stop early — not to
    stop at the *matching* tag. On a real game file it ran straight past the
    share dialog and deleted #game-container, #chapter-bar and the particle
    canvas with it. Counting opens and closes is the only correct way.
    """
    start = html.find(opening)
    if start < 0:
        return html
    tag = opening[1:].split()[0].split(">")[0]          # "div"
    open_tag, close_tag = f"<{tag}", f"</{tag}>"
    depth, i = 0, start
    while i < len(html):
        next_open = html.find(open_tag, i)
        next_close = html.find(close_tag, i)
        if next_close < 0:
            return html                                  # unbalanced: change nothing
        if 0 <= next_open < next_close:
            depth += 1
            i = next_open + len(open_tag)
            continue
        depth -= 1
        i = next_close + len(close_tag)
        if depth == 0:
            return html[:start] + html[i:]
    return html


def presentation_css(theme: dict) -> str:
    """Render the template's presentation block against one game's own theme."""
    import jinja2

    template = (REPO / "edgameclaw" / "engine" / "template.html").read_text(encoding="utf-8")
    marker = "/* ══ Presentation pass"
    if marker not in template:
        raise SystemExit("template.html has no presentation block to copy.")
    start = template.index(marker)
    block = template[start : template.index("</style>", start)]
    css = jinja2.Environment(undefined=jinja2.StrictUndefined, autoescape=False) \
        .from_string(block).render(theme=theme)
    if "{{" in css:
        raise SystemExit("presentation block still has unresolved template variables.")
    return css


APPEARANCE_START = "/* EDGC-APPEARANCE-START */"
APPEARANCE_END = "/* EDGC-APPEARANCE-END */"

#: Hardcoded colours in older templates that cannot follow an appearance.
#: A "lift" is derived from the text colour so it inverts with the theme; an
#: overlay becomes the theme's own panel colour; a drop shadow stays black,
#: because a shadow is physical and does not belong to the palette.
_APPEARANCE_FIXES = [
    (r"rgba\(255,\s*255,\s*255,\s*0?\.12\)", "color-mix(in srgb, var(--t-text) 12%, transparent)"),
    (r"rgba\(255,\s*255,\s*255,\s*0?\.25\)", "color-mix(in srgb, var(--t-text) 25%, transparent)"),
    (r"rgba\(255,\s*255,\s*255,\s*0?\.0?8\)", "color-mix(in srgb, var(--t-text) 8%, transparent)"),
    (r"rgba\(255,\s*255,\s*255,\s*0?\.0?6\)", "color-mix(in srgb, var(--t-text) 6%, transparent)"),
    (r"rgba\(255,\s*255,\s*255,\s*0?\.0?5\)", "color-mix(in srgb, var(--t-text) 5%, transparent)"),
    (r"rgba\(255,\s*255,\s*255,\s*0?\.0?4\)", "color-mix(in srgb, var(--t-text) 4%, transparent)"),
    (r"rgba\(10,\s*8,\s*16,\s*0?\.\d+\)", "color-mix(in srgb, var(--t-containerBg) 88%, transparent)"),
    (r"rgba\(16,\s*4,\s*14,\s*0?\.\d+\)", "color-mix(in srgb, var(--t-containerBg) 88%, transparent)"),
    (r"rgba\(17,\s*13,\s*32,\s*0?\.\d+\)", "var(--t-containerBg)"),
    (r"rgba\(60,\s*25,\s*50,\s*0?\.\d+\)", "var(--t-cardHover)"),
    (r"rgba\(40,\s*15,\s*30,\s*0?\.\d+\)", "var(--t-dialogBg)"),
    (r"rgba\(80,\s*20,\s*50,\s*0?\.\d+\)", "rgba(0,0,0,0.45)"),
]

_TOGGLE_MARK = "edgc-appearance-toggle"


def add_appearance(html: str, theme: dict) -> tuple[str, bool]:
    """Make an already-generated game switchable between light and dark.

    The template now declares colours as custom properties, but a finished game
    has them baked in — adding variables alone would change nothing. So the
    literals are replaced by references *inside the stylesheet only*: the same
    values appear hundreds of times in the generated art and game code, where
    they are drawing instructions rather than interface colour and must not be
    touched.
    """
    from theme_light import to_light  # type: ignore[import-not-found]

    if _TOGGLE_MARK in html:
        html = _strip_previous(html)
    if "<style>" not in html or "</style>" not in html:
        return html, False

    start = html.index("<style>") + len("<style>")
    end = html.index("</style>")
    head, style, tail = html[:start], html[start:end], html[end:]

    # Longest values first: a short value must not eat part of a longer one.
    pairs = sorted(theme.items(), key=lambda kv: (-len(str(kv[1])), kv[0]))
    seen: set[str] = set()
    replaced = 0
    for key, value in pairs:
        if not isinstance(value, str) or value in seen:
            continue          # two keys sharing a value collapse onto the first
        seen.add(value)
        count = style.count(value)
        if count:
            style = style.replace(value, f"var(--t-{key})")
            replaced += count
    for pattern, replacement in _APPEARANCE_FIXES:
        style = re.sub(pattern, replacement, style)

    # A second run finds no literals left to convert, because the first run
    # already replaced them. Bailing here after _strip_previous() has removed
    # the palette is what silently un-themed a game on every re-run: strip,
    # then give up, leaving var(--t-*) references with nothing declaring them.
    already_converted = "var(--t-" in style
    if not replaced and not already_converted:
        return html, False

    light = to_light(theme)
    palette = (
        f"\n{APPEARANCE_START}\n:root{{\n"
        + "".join(f"  --t-{k}: {v};\n" for k, v in theme.items())
        + "}\n:root[data-appearance=\"light\"]{\n"
        + "".join(f"  --t-{k}: {v};\n" for k, v in light.items())
        + "}\n" + APPEARANCE_END + "\n"
    )
    html = head + palette + style + tail

    # Choose the appearance before the first paint, so nothing flashes.
    boot = ("<script>(function(){try{var m=localStorage.getItem('edgc_game_appearance');"
            "if(m!=='light'&&m!=='dark')m='dark';document.documentElement.setAttribute('data-appearance',m);}"
            "catch(e){document.documentElement.setAttribute('data-appearance','dark');}})();</script>\n")
    html = html.replace("</head>", boot + "</head>", 1)

    toggle = f"""
<button type="button" id="{_TOGGLE_MARK}" aria-label="Light / dark"
  style="position:absolute;top:14px;right:92px;z-index:210;width:30px;height:30px;border-radius:999px;
         background:var(--t-cardBg);border:2px solid var(--t-border);color:var(--t-muted);
         cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:0">&#9681;</button>
<script>
(function () {{
  var btn = document.getElementById('{_TOGGLE_MARK}');
  if (!btn) return;
  btn.addEventListener('click', function () {{
    var now = document.documentElement.getAttribute('data-appearance') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-appearance', now);
    try {{ localStorage.setItem('edgc_game_appearance', now); }} catch (e) {{}}
  }});
}})();
</script>
"""
    html = html.replace("</body>", toggle + "</body>", 1)
    return html, True


def _strip_previous(html: str) -> str:
    """Undo an earlier run so this one is a clean rewrite, not a stack."""
    html = re.sub(re.escape(APPEARANCE_START) + r".*?" + re.escape(APPEARANCE_END), "", html, flags=re.S)
    html = re.sub(r"<button type=\"button\" id=\"" + _TOGGLE_MARK + r"\".*?</script>\n", "", html, flags=re.S)
    html = re.sub(r"<script>\(function\(\)\{try\{var m=localStorage\.getItem\('edgc_game_appearance'\).*?</script>\n", "", html, flags=re.S)
    return html


PACK_MARK = "EDGC-PIXELPACK"


def add_pixel_pack(html: str, theme_name: str = "") -> tuple[str, bool]:
    """Skin an already-generated game's interface with the asset pack.

    Only the runtime: engine.js reads window.PIXELPACK_BASE for its heart HUD
    and portrait lookups, and a generated simulation may call PixelPack.

    It deliberately does NOT call PixelPack.skinDialog(). That is a second,
    competing dialogue skin; the chosen one lives in the template's <style>
    block, and running both stacks a frame inside a frame with the name tab
    under the text. See the note in engine/template.html.
    """
    if PACK_MARK in html:
        html = re.sub(r"<script>/\* " + PACK_MARK + r" \*/.*?</script>\n", "", html, flags=re.S)
    runtime = REPO / "edgameclaw" / "engine" / "pixelpack.js"
    if not runtime.exists() or "</body>" not in html:
        return html, False

    block = (
        "<script>/* " + PACK_MARK + " */\n"
        + 'window.PIXELPACK_BASE = window.PIXELPACK_BASE || "/assets/pixelpack/";\n'
        + runtime.read_text(encoding="utf-8")
        + "\n(function () {\n"
        + "  if (!window.PixelPack) return;\n"
        + "  PixelPack.ready().then(function (available) {\n"
        + "    if (!available) return;\n"
        + "  });\n"
        + "})();\n</script>\n"
    )
    return html.replace("</body>", block + "</body>", 1), True


FULLSCREEN_MARK = "EDGC-FULLSCREEN"


def add_fullscreen(html: str) -> tuple[str, bool]:
    """Give a finished game a fullscreen control.

    The document goes fullscreen rather than the stage: the stage carries a
    transform from the scaler, and a transformed element fullscreens at its
    untransformed size with letterboxing around it. Fullscreening the document
    just hands the existing scaler a bigger viewport.
    """
    if FULLSCREEN_MARK in html:
        html = re.sub(r"<script>/\* " + FULLSCREEN_MARK + r" \*/.*?</script>\n", "", html, flags=re.S)
    if "</body>" not in html:
        return html, False

    # The baked scaler leaves a margin for browser chrome and caps the upscale;
    # neither applies once the stage is the only thing on screen.
    before = html
    html = html.replace(
        "var s=Math.min((vw*0.96)/768,(vh*0.94)/576,1.7);",
        "var _fs=!!(document.fullscreenElement||document.webkitFullscreenElement);"
        "var s=Math.min((vw*(_fs?0.995:0.96))/768,(vh*(_fs?0.995:0.94))/576,_fs?3:1.7);")
    rescaled = html != before

    block = """<script>/* """ + FULLSCREEN_MARK + """ */
(function () {
  var bar = document.getElementById('audio-controls');
  var root = document.documentElement;
  if (!bar || !(root.requestFullscreen || root.webkitRequestFullscreen)) return;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'audio-btn';
  btn.id = 'edgc-fullscreen-btn';
  btn.setAttribute('aria-label', 'Fullscreen');
  bar.appendChild(btn);

  function on() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function sync() { btn.innerHTML = on() ? '&#10717;' : '&#9974;'; btn.setAttribute('aria-pressed', String(on())); }

  btn.addEventListener('click', function () {
    var done = on()
      ? (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document)
      : (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    if (done && done.catch) done.catch(function () { /* refused: stay windowed */ });
  });

  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (e) {
    document.addEventListener(e, function () {
      sync();
      // The scaler lives in a closure in older games, so nudge it the way it
      // already listens: a resize event.
      setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'f' && !/input|textarea/i.test((e.target && e.target.tagName) || '')) btn.click();
  });
  sync();
})();
</script>
"""
    return html.replace("</body>", block + "</body>", 1), (True or rescaled)


def restyle(html: str, theme: dict, theme_name: str = "") -> tuple[str, list[str]]:
    changed: list[str] = []

    # Share UI — markup, the title-screen link, the dialog and its script.
    before = html
    html = re.sub(r'<button type="button" id="share-btn".*?</button>', "", html, flags=re.S)
    html = re.sub(r'<a href="javascript:void\(0\)"\s+class="share-link".*?</a>', "", html, flags=re.S)
    html = _drop_element(html, '<div id="share-modal"')
    html = re.sub(r"<script>window\.openShareModal[^\n]*\n", "", html)
    if html != before:
        changed.append("share UI removed")

    # The cap meant the stage could only ever shrink.
    before = html
    html = html.replace("Math.min(vw/768,vh/576,1)", "Math.min((vw*0.96)/768,(vh*0.94)/576,1.7)")
    html = html.replace("if(s<0.999){", "if(s<0.999||s>1.001){")
    if html != before:
        changed.append("scale unlocked")

    # Presentation block, replacing any previous run of this tool.
    html = re.sub(re.escape(START) + r".*?" + re.escape(END), "", html, flags=re.S)
    css = f"\n{START}\n{presentation_css(theme)}\n{END}\n"
    index = html.rfind("</style>")
    if index < 0:
        return html, changed
    html = html[:index] + css + html[index:]
    changed.append("presentation applied")

    html, switched = add_appearance(html, theme)
    if switched:
        changed.append("light/dark added")

    html, packed = add_pixel_pack(html, theme_name)
    if packed:
        changed.append("pack runtime wired")

    html, full = add_fullscreen(html)
    if full:
        changed.append("fullscreen added")
    return html, changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="*", default=None,
                        help="course directories (default: every course under courses/)")
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    args = parser.parse_args()

    roots = [Path(r) for r in args.roots] if args.roots else [REPO / "courses"]
    games = sorted({g for root in roots for g in root.glob("**/games/*/index.html")})
    if not games:
        print("No generated games found.")
        return 0

    done = failed = 0
    for game in games:
        package = game.with_name("game.pkg.json")
        if not package.exists():
            print(f"  skip  {game.parent.name}: no game.pkg.json (cannot read its theme)")
            failed += 1
            continue
        try:
            package = json.loads(package.read_text(encoding="utf-8"))
            theme = package.get("theme")
            name = str(package.get("config", {}).get("theme") or package.get("themeName") or "")
            if not isinstance(theme, dict) or "accent" not in theme:
                raise ValueError("no usable theme in game.pkg.json")
            html, changed = restyle(game.read_text(encoding="utf-8"), theme, name)
        except Exception as exc:
            print(f"  FAIL  {game.parent.name}: {exc}")
            failed += 1
            continue
        label = f"{game.parent.parent.parent.name}/{game.parent.name}"
        if args.dry_run:
            print(f"  would {label}: {', '.join(changed)}")
        else:
            game.write_text(html, encoding="utf-8")
            print(f"  ok    {label}: {', '.join(changed)}")
        done += 1

    print(f"\n{done} game(s) {'checked' if args.dry_run else 'restyled'}"
          + (f", {failed} skipped" if failed else ""))
    return 1 if failed and not done else 0


if __name__ == "__main__":
    raise SystemExit(main())
