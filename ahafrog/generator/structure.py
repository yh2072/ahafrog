# =============================================================================
# AhaFrog — AI Game-Based Learning Studio
# Created by Yuqi Hang (github.com/yh2072)
# https://github.com/yh2072/ahafrog
# =============================================================================
"""Turn arbitrary learning material into lessons, without asking the author to
structure it first.

`server.parse_markdown` only produces a lesson when it meets a `## ` line, so
pasting a paper, lecture notes or a PDF's body text yields zero lessons and the
Studio refuses to continue. This module is the fallback: it finds whatever
structure the text *does* have and, when there is none, partitions by length at
paragraph boundaries.

Three tiers, most explicit first:

  1. ``headings``    — the text has Markdown headings; sections come from them.
  2. ``paragraphs``  — no headings at all; split purely by length.

The invariant that makes "the whole text is kept" true by construction rather
than by a later check: lessons are ordered, disjoint ranges over the source
string. Splitting only ever adds a boundary, and merging only ever regroups
existing ranges, so no character is dropped or duplicated.

No model is called here. Parsing is local and free.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ── Tunables ─────────────────────────────────────────────────────────────────

#: A lesson becomes one generated mini-game. AhaFrog's own sample course runs
#: a few hundred characters per `## ` section, so the target is far below the
#: paper-sized chunks a document importer would use. 1,500 characters is about
#: one screen of material, which is one game's worth; a 6,000-character article
#: becomes four games rather than one overloaded one.
DEFAULT_TARGET_CHARACTERS = 1500
DEFAULT_MAX_LESSONS = 12

MIN_TARGET_CHARACTERS = 500
MAX_TARGET_CHARACTERS = 20000
MIN_MAX_LESSONS = 1
MAX_MAX_LESSONS = 60

#: Recursion bound for the splitter; 20 levels is 2^20 pieces, far beyond any
#: real document, so hitting it means something pathological.
_MAX_SPLIT_DEPTH = 20

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_BULLET = re.compile(r"^[-*]\s+(.+)$")

#: Trailing matter that is kept in the source for provenance but makes a poor
#: lesson on its own.
_BACK_MATTER = re.compile(
    r"^(references|bibliography|works cited|literature cited|index|acknowledge?ments?"
    r"|参考文献|致谢|索引|附录)\s*$",
    re.IGNORECASE,
)



#: Ceiling for an automatically chosen lesson count. Each lesson is one
#: generated game that costs tokens and minutes, so a long book must not turn
#: into hundreds of them; past this the partitioner merges instead.
MAX_AUTO_LESSONS = 24
#: Below this a "lesson" has too little to build a game from.
MIN_CHARS_PER_LESSON = 600


def suggest_lessons(characters: int) -> int:
    """How many lessons a document of this length should become.

    Deliberately sublinear — ten times the text makes about three times the
    lessons, not ten times. Dividing length by a per-lesson target instead would
    turn a 318,000-character review into 212 games: more than anyone would
    generate, pay for, or play. Growing with the square root keeps a short note
    at one or two lessons while a book lands near the ceiling.

        400 chars -> 1      20,000 -> 7
      4,000 chars -> 3      81,000 -> 14
                           318,000 -> 24 (capped)
    """
    if characters <= 0:
        return 1
    suggested = round((characters / 400) ** 0.5)
    suggested = min(suggested, characters // MIN_CHARS_PER_LESSON)
    return max(1, min(MAX_AUTO_LESSONS, suggested))


@dataclass
class StructureOptions:
    """How finely to cut the material."""

    #: 0 means "choose from the document's length" (see suggest_lessons).
    max_lessons: int = DEFAULT_MAX_LESSONS
    target_characters: int = DEFAULT_TARGET_CHARACTERS
    #: "sections" keeps the author's own headings as lesson boundaries;
    #: "length" ignores them and aims for evenly sized lessons.
    grouping: str = "sections"

    def validate(self) -> None:
        if self.grouping not in ("sections", "length"):
            raise ValueError("grouping must be 'sections' or 'length'")
        if self.max_lessons != 0 and not (MIN_MAX_LESSONS <= self.max_lessons <= MAX_MAX_LESSONS):
            raise ValueError(
                f"max_lessons must be between {MIN_MAX_LESSONS} and {MAX_MAX_LESSONS}"
            )
        if not (MIN_TARGET_CHARACTERS <= self.target_characters <= MAX_TARGET_CHARACTERS):
            raise ValueError(
                f"target_characters must be between {MIN_TARGET_CHARACTERS} "
                f"and {MAX_TARGET_CHARACTERS}"
            )


@dataclass
class _Section:
    id: str
    title: str
    level: int
    start: int
    end: int
    children: list["_Section"] = field(default_factory=list)


@dataclass
class _Range:
    start: int
    end: int
    title: str
    section_id: str


# ── Text normalisation ───────────────────────────────────────────────────────

def normalize(text: str) -> str:
    """Newline-normalise and collapse runs of blank lines.

    Paragraph boundaries are the splitter's only cut points, so they must be
    consistent: a PDF extractor that emits three blank lines between paragraphs
    would otherwise produce different cuts than the same text typed by hand.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace(" ", " ")
    # Lines of only whitespace count as blank.
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip("\n")


# ── Title inference ──────────────────────────────────────────────────────────

#: Sentence enders in the languages the Studio ships locales for.
_SENTENCE_END = re.compile(r"[。！？!?.;；]")


def _snippet(line: str, limit: int) -> str:
    """Take the opening sentence of `line`, bounded by `limit`.

    The *first* sentence end wins, not the last one that fits: a title is what
    the text opens by saying, so "注意力机制让模型回看整个序列。" beats three
    run-on sentences that merely fit inside the character budget. A hard cut
    with an ellipsis is the last resort, for text with no sentence ender at all.
    """
    line = line.strip()
    for match in _SENTENCE_END.finditer(line[: limit + 1]):
        if match.end() >= 6:
            return line[: match.end()].rstrip()
    if len(line) <= limit:
        return line
    return line[:limit].rstrip() + "…"


def infer_title(text: str, fallback: str = "") -> str:
    """The course title: a leading `# ` heading, else the first real line."""
    for match in _HEADING.finditer(text):
        if len(match.group(1)) == 1:
            return match.group(2).strip()
    for raw in text.split("\n"):
        line = raw.strip().lstrip("#").strip()
        line = _BULLET.sub(r"\1", line)
        if len(line) >= 2:
            # A first line that is really a paragraph makes a poor title.
            return _snippet(line, 48)
    return fallback or "Untitled course"


# ── Section tree ─────────────────────────────────────────────────────────────

def _build_sections(text: str) -> list[_Section]:
    """Nest Markdown headings into a tree of half-open [start, end) ranges."""
    roots: list[_Section] = []
    stack: list[_Section] = []
    serial = 0

    for match in _HEADING.finditer(text):
        level = len(match.group(1))
        title = match.group(2).strip()
        offset = match.start()
        while stack and stack[-1].level >= level:
            stack.pop().end = offset
        serial += 1
        section = _Section(
            id=f"section-{serial}", title=title, level=level,
            start=offset, end=len(text),
        )
        (stack[-1].children if stack else roots).append(section)
        stack.append(section)

    def finish(nodes: list[_Section], end: int) -> None:
        for i, node in enumerate(nodes):
            following = nodes[i + 1].start if i + 1 < len(nodes) else end
            node.end = min(node.end, following)
            finish(node.children, node.end)

    finish(roots, len(text))
    return roots


def _to_ranges(text: str, roots: list[_Section]) -> tuple[list[_Range], list[str]]:
    """Flatten the tree into ordered, disjoint ranges.

    A parent keeps the text between its own heading and its first child, so an
    introduction written under "3 Methods" before "3.1" is not lost.
    """
    ranges: list[_Range] = []
    set_aside: list[str] = []

    def visit(nodes: list[_Section]) -> None:
        for node in nodes:
            if _BACK_MATTER.match(node.title.strip()):
                set_aside.append(node.title.strip())
                continue
            end = node.children[0].start if node.children else node.end
            if end > node.start:
                ranges.append(_Range(node.start, end, node.title, node.id))
            visit(node.children)

    if roots and roots[0].start > 0:
        # Text before the first heading is still material.
        ranges.append(_Range(0, roots[0].start, "", roots[0].id))
    visit(roots)
    return ranges, set_aside


# ── Splitting and merging ────────────────────────────────────────────────────

def _split(text: str, rng: _Range, target: int, out: list[_Range], depth: int = 0) -> None:
    """Halve a long range at the paragraph break nearest its midpoint.

    The candidate cut must sit at least a quarter of `target` from either end,
    which is what stops the recursion from shaving off slivers: without it a
    break near the very start would produce a 200-character lesson and leave the
    rest just as long.
    """
    if rng.end - rng.start <= target or depth >= _MAX_SPLIT_DEPTH:
        out.append(rng)
        return

    midpoint = (rng.start + rng.end) // 2
    before = text.rfind("\n\n", rng.start, midpoint)
    after = text.find("\n\n", midpoint, rng.end)
    margin = target // 4
    candidates = [
        n for n in (before, after)
        if n != -1 and rng.start + margin < n < rng.end - margin
    ]
    cut = min(candidates, key=lambda n: abs(n - midpoint)) if candidates else midpoint

    _split(text, _Range(rng.start, cut, rng.title, rng.section_id), target, out, depth + 1)
    _split(text, _Range(cut, rng.end, rng.title, rng.section_id), target, out, depth + 1)


def _group(pieces: list[_Range], target: int, section_based: bool) -> list[list[_Range]]:
    """Merge adjacent pieces that are short enough to share one lesson."""
    groups: list[list[_Range]] = []
    for piece in pieces:
        previous = groups[-1] if groups else None
        same_section = previous is not None and previous[-1].section_id == piece.section_id
        fits = previous is not None and piece.end - previous[0].start <= target
        if previous is not None and fits and (not section_based or same_section):
            previous.append(piece)
        else:
            groups.append([piece])
    return groups


def _enforce_cap(groups: list[list[_Range]], max_lessons: int) -> list[list[_Range]]:
    """Merge the smallest adjacent pair until the lesson cap is met."""
    while len(groups) > max_lessons and len(groups) > 1:
        span = lambda i: groups[i + 1][-1].end - groups[i][0].start  # noqa: E731
        best = min(range(len(groups) - 1), key=span)
        groups[best : best + 2] = [groups[best] + groups[best + 1]]
    return groups


# ── Lesson assembly ──────────────────────────────────────────────────────────

def _clean_body(raw: str) -> str:
    """Strip heading markers and tidy bullets for the generator's prompt."""
    lines: list[str] = []
    for line in raw.split("\n"):
        stripped = line.strip()
        heading = _HEADING.match(stripped + "\n") or re.match(r"^#{1,6}\s+(.+)$", stripped)
        if heading:
            title = heading.group(2) if heading.lastindex and heading.lastindex >= 2 else heading.group(1)
            lines.append(f"**{title.strip()}**")
            continue
        bullet = _BULLET.match(stripped)
        if bullet:
            lines.append(f"• {bullet.group(1).strip()}")
            continue
        lines.append(stripped)
    body = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", body).strip()


def _lesson_title(text: str, group: list[_Range], index: int) -> str:
    """Name a lesson after the shallowest heading that starts inside it."""
    titled = [r for r in group if r.title]
    if titled:
        return titled[0].title
    # No heading anywhere in this range: name it after its opening sentence.
    body = _clean_body(text[group[0].start : group[-1].end])
    first = next((l.strip(" •*") for l in body.split("\n") if len(l.strip(" •*")) >= 2), "")
    if first:
        return _snippet(first, 40)
    return f"Part {index + 1}"


def autostructure(
    text: str,
    *,
    title_hint: str = "",
    options: StructureOptions | None = None,
    themes: list[str] | None = None,
) -> dict:
    """Partition arbitrary material into lessons.

    Returns the same ``{"course": …, "chunks": […]}`` shape the Studio already
    consumes, plus ``structure`` and ``warnings`` describing what was inferred.
    """
    options = options or StructureOptions()
    options.validate()
    themes = themes or ["pink-cute"]

    text = normalize(text)
    if not text.strip():
        return {
            "course": _empty_course(title_hint),
            "chunks": [],
            "structure": "empty",
            "warnings": ["The document has no readable text."],
        }

    roots = _build_sections(text)
    structure = "headings" if roots else "paragraphs"
    warnings: list[str] = []

    if roots:
        ranges, set_aside = _to_ranges(text, roots)
        if set_aside:
            warnings.append(
                f"{', '.join(set_aside)} kept as reference material, not made into lessons."
            )
    else:
        ranges, set_aside = [_Range(0, len(text), "", "section-1")], []

    if not ranges:
        ranges = [_Range(0, len(text), "", "section-1")]

    # Counted after back matter is set aside: a bibliography must not inflate
    # the lesson count for material nobody will play.
    teachable = sum(r.end - r.start for r in ranges)
    auto = options.max_lessons == 0
    max_lessons = suggest_lessons(teachable) if auto else options.max_lessons

    section_based = options.grouping == "sections" and structure != "paragraphs"
    target = options.target_characters
    if not section_based:
        # Aim for lessons that actually fit under the cap.
        target = max(target, -(-teachable // max_lessons))

    pieces: list[_Range] = []
    for rng in ranges:
        _split(text, rng, target, pieces)

    groups = _enforce_cap(_group(pieces, target, section_based), max_lessons)

    chunks = []
    for i, group in enumerate(groups):
        body = _clean_body(text[group[0].start : group[-1].end])
        if not body:
            continue
        chunks.append({
            "id": f"chunk-{len(chunks) + 1}",
            "title": _lesson_title(text, group, i),
            "subtitle": "",
            "theme": themes[len(chunks) % len(themes)],
            "learning_objectives": [],
            "content": body,
        })

    # Two lessons cut from one long section would otherwise share a title, which
    # makes the outline unreadable and the generated games indistinguishable.
    seen: dict[str, int] = {}
    for chunk in chunks:
        count = seen.get(chunk["title"], 0) + 1
        seen[chunk["title"]] = count
        if count > 1:
            chunk["title"] = f"{chunk['title']} · {count}"

    if not chunks:
        warnings.append("No lesson-sized text was found in the document.")

    title = infer_title(text, title_hint)
    course = _empty_course(title)
    if chunks:
        names = [c["title"] for c in chunks[:3]]
        course["subtitle"] = " · ".join(names) + (" ..." if len(chunks) > 3 else "")
    if len(chunks) == max_lessons and len(pieces) > len(groups):
        warnings.append(
            f"Merged to stay within {max_lessons} lessons; raise the limit for finer lessons."
            if not auto else
            f"Split into {max_lessons} lessons for a document this long; set a number to override."
        )

    return {
        "course": course, "chunks": chunks, "structure": structure, "warnings": warnings,
        "options": {
            "max_lessons": max_lessons, "target_characters": options.target_characters,
            "auto_lessons": auto, "teachable_characters": teachable,
        },
    }


def _empty_course(title: str) -> dict:
    return {
        "title": title, "subtitle": "", "description": "", "subject": "",
        "level": "", "estimated_time": "", "learning_objectives": [], "tags": [],
    }
