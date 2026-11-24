# =============================================================================
# AhaFrog — AI Game-Based Learning Studio
# Created by Yuqi Hang (github.com/yh2072)
# https://github.com/yh2072/ahafrog
# =============================================================================
"""Read uploaded course material (PDF, Markdown, plain text) into text.

Extraction is local and free: no model is called. A PDF contributes its text
layer only — this does not reconstruct tables, equations or figures, and a
scanned PDF has no text layer at all, which is reported as a warning rather
than silently producing an empty course.
"""

from __future__ import annotations

import io
import re

#: Keep uploads small enough to parse synchronously inside a request.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_PDF_PAGES = 500

SUPPORTED_EXTENSIONS = (".pdf", ".md", ".markdown", ".txt", ".text")


class DocumentError(ValueError):
    """A problem the user can fix: wrong type, too big, no readable text."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _decode(data: bytes) -> str:
    """Decode text, tolerating the encodings real-world notes arrive in."""
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _clean_pdf_text(text: str) -> str:
    """Undo the line wrapping a PDF text layer imposes.

    Extractors emit one newline per visual line, which would make every line
    look like its own paragraph to the splitter. Joining wrapped lines back
    into paragraphs is what lets paragraph-boundary splitting work at all.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # A hyphen at end of line is a word broken across lines.
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    lines = [l.rstrip() for l in text.split("\n")]
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            out.append("")
            continue
        previous = out[-1] if out else ""
        # Continue the previous line unless it ended a sentence or this one
        # starts something new (bullet, number, heading-like short line).
        continues = (
            previous
            and not re.search(r"[.!?。！？:：;；]$", previous)
            and not re.match(r"^\s*(?:[-*•]|\d+[.)]|#{1,6}\s)", stripped)
            and len(previous) > 40
        )
        if continues:
            joiner = "" if re.search(r"[一-鿿]$", previous) else " "
            out[-1] = previous + joiner + stripped
        else:
            out.append(stripped)
    text = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", text).strip()



# ── Structure recovery ───────────────────────────────────────────────────────

#: Ligatures a PDF text layer emits as single glyphs. Both the bookmark titles
#: and the page text carry them, so both sides must normalise identically or a
#: title like "Signiﬁcance" will never match its own page.
_LIGATURES = {
    "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi",
    "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st",
}

#: "4.3.4 Biophysical modeling of single neurons" — a numbered section heading,
#: used when a PDF carries no bookmarks.
_NUMBERED_HEADING = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,4})[.)]?\s+([^\s].{2,90})$")

#: Unnumbered parts a paper still has. Matched on a whole short line.
_NAMED_HEADING = re.compile(
    r"^(abstract|introduction|background|related work|methods?|materials and methods"
    r"|results?|discussion|conclusions?|limitations|acknowledge?ments?|references"
    r"|bibliography|appendix(?:\s+[A-Z0-9][\w.]*)?|supplementary(?:\s+\w+)*"
    r"|摘要|引言|背景|相关工作|方法|结果|讨论|结论|致谢|参考文献|附录)\s*$",
    re.IGNORECASE,
)


def _fold(text: str) -> str:
    for src, dst in _LIGATURES.items():
        text = text.replace(src, dst)
    return text


def _match_key(text: str) -> str:
    """Letters and digits only — for comparing a bookmark with its page text."""
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", _fold(text).lower())


def _outline_entries(reader) -> list[tuple[int, str, int]]:
    """Flatten a PDF's bookmarks into (level, title, page_index).

    Bookmarks are the most reliable structure a PDF offers: an author wrote
    them, so they beat any heuristic over the text layer.
    """
    try:
        outline = reader.outline
    except Exception:
        return []

    entries: list[tuple[int, str, int]] = []

    def walk(items, level=0):
        for item in items:
            if isinstance(item, list):
                walk(item, level + 1)
                continue
            try:
                title = _fold(str(item.title)).strip()
                page = reader.get_destination_page_number(item)
            except Exception:
                continue
            if title and page is not None:
                entries.append((level, title, int(page)))

    try:
        walk(outline)
    except Exception:
        return []
    return entries


def _headings_from_text(page_text: str) -> list[tuple[int, str, int]]:
    """Find headings typographically-blind: by shape alone.

    Without bookmarks the only signal left in a text layer is the shape of a
    line — short, on its own, numbered like "3.2 Results" or named like
    "References". Deliberately conservative: a false heading splits a lesson in
    the wrong place, which is worse than missing one.
    """
    found: list[tuple[int, str, int]] = []
    offset = 0
    for line in page_text.split("\n"):
        stripped = line.strip()
        length = len(line) + 1
        if 2 < len(stripped) <= 95:
            numbered = _NUMBERED_HEADING.match(stripped)
            named = _NAMED_HEADING.match(stripped)
            if numbered:
                depth = numbered.group(1).count(".") + 1
                found.append((depth, stripped, offset))
            elif named:
                found.append((1, stripped, offset))
        offset += length
    return found


def _assemble_markdown(
    page_texts: list[str],
    outline: list[tuple[int, str, int]],
) -> tuple[str, str]:
    """Weave headings into the page text as Markdown.

    Turning recovered structure into ordinary `#` lines means the partitioner
    needs no PDF-specific path: section nesting, back-matter removal and lesson
    naming all work on Markdown already.
    """
    by_page: dict[int, list[tuple[int, str]]] = {}
    for level, title, page in outline:
        by_page.setdefault(page, []).append((level, title))
    structure = "outline" if outline else "paragraphs"

    if not outline:
        # No bookmarks: fall back to the shape of the lines themselves.
        for index, text in enumerate(page_texts):
            for depth, title, _ in _headings_from_text(text):
                by_page.setdefault(index, []).append((depth, title))
        if by_page:
            structure = "headings"
    else:
        # Bookmarks rarely cover the bibliography, so it ends up swallowed by
        # whichever section precedes it — 172k characters of citations becoming
        # one "lesson". Promote those headings even when an outline exists, so
        # the partitioner can set them aside.
        known = {_match_key(t) for _, t, _ in outline}
        for index, text in enumerate(page_texts):
            for depth, title, _ in _headings_from_text(text):
                if _NAMED_HEADING.match(title.strip()) and _match_key(title) not in known:
                    by_page.setdefault(index, []).append((1, title.strip()))

    out: list[str] = []
    for index, text in enumerate(page_texts):
        headings = by_page.get(index, [])
        if not headings:
            out.append(text)
            continue
        # Place each heading at its own text when findable, else at the page top.
        placed: list[tuple[int, int, str]] = []
        key_text = _match_key(text)
        for level, title in headings:
            key = _match_key(title)
            pos = key_text.find(key) if key else -1
            placed.append((pos if pos >= 0 else -1, level, title))

        page_out: list[str] = []
        if any(p < 0 for p, _, _ in placed):
            for pos, level, title in placed:
                if pos < 0:
                    page_out.append("#" * min(6, level + 1) + " " + title)
        # Anything located inside the page splits it at that point.
        located = sorted((p, l, t) for p, l, t in placed if p >= 0)
        if not located:
            page_out.append(text)
        else:
            # Map the key offset back to a real offset in the page text.
            cursor = 0
            key_to_real = []
            for i, ch in enumerate(text):
                if _match_key(ch):
                    key_to_real.append(i)
            previous = 0
            for pos, level, title in located:
                real = key_to_real[pos] if pos < len(key_to_real) else len(text)
                chunk = text[previous:real].strip()
                if chunk:
                    page_out.append(chunk)
                page_out.append("#" * min(6, level + 1) + " " + title)
                previous = real + len(title)
            rest = text[previous:].strip()
            if rest:
                page_out.append(rest)
            cursor = cursor  # noqa: F841 - clarity over cleverness
        out.append("\n\n".join(x for x in page_out if x))

    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(out)).strip(), structure



#: Producer junk that shows up in /Title and should not become a course name.
_JUNK_TITLE = re.compile(
    r"^(untitled|document\d*|microsoft word\s*-.*|.*\.(?:docx?|tex|pdf|indd)|print(?:out)?)$",
    re.IGNORECASE,
)


def _metadata_title(reader) -> str:
    """The document's own title, when it has a usable one.

    A paper's /Title is almost always better than its filename: "NeuroAI for AI
    safety" rather than "2411.18526v2". Export tools also leave junk there, so
    anything that looks like a filename or placeholder is rejected.
    """
    try:
        meta = reader.metadata or {}
        raw = meta.get("/Title")
    except Exception:
        return ""
    title = _fold(str(raw or "")).strip()
    if not (3 <= len(title) <= 200) or _JUNK_TITLE.match(title):
        return ""
    return re.sub(r"\s+", " ", title)


def extract_pdf(data: bytes) -> dict:
    """Read a PDF into Markdown, recovering its structure where it exists."""
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - depends on install extras
        raise DocumentError(
            "PDF support needs the 'pypdf' package. Install it with: pip install pypdf",
            status_code=501,
        ) from exc

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise DocumentError(f"Could not read this PDF: {exc}") from exc

    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            raise DocumentError("This PDF is password-protected. Remove the password and retry.")

    pages = reader.pages
    if len(pages) > MAX_PDF_PAGES:
        raise DocumentError(
            f"At most {MAX_PDF_PAGES} pages at a time — split the PDF by chapter.",
            status_code=413,
        )

    warnings: list[str] = []
    page_texts: list[str] = []
    empty = 0
    for page in pages:
        try:
            page_text = page.extract_text() or ""
        except Exception:
            page_text = ""
        if not page_text.strip():
            empty += 1
        page_texts.append(_clean_pdf_text(_fold(page_text)))

    if not any(t.strip() for t in page_texts):
        raise DocumentError(
            "This PDF has no text layer — it is probably a scan. "
            "Run OCR on it first, or paste the text directly."
        )

    outline = _outline_entries(reader)
    body, structure = _assemble_markdown(page_texts, outline)

    if outline:
        warnings.append(f"Recovered {len(outline)} sections from the PDF's bookmarks.")
    elif structure == "headings":
        warnings.append("No bookmarks — sections inferred from numbered headings; check the split.")
    else:
        warnings.append("No headings found — the text was split by length; check the split.")

    if empty:
        warnings.append(
            f"{empty} of {len(pages)} pages had no extractable text "
            "(scanned pages or figures); their content is missing."
        )
    warnings.append("PDF text only — tables, equations and figures are not carried over.")
    return {"text": body, "pages": len(pages), "warnings": warnings,
            "kind": "pdf", "structure": structure, "title": _metadata_title(reader)}


def extract(filename: str, data: bytes) -> dict:
    """Read an uploaded file into ``{text, pages, warnings, kind}``."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise DocumentError(
            f"The file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            status_code=413,
        )
    if not data:
        raise DocumentError("The file is empty.")

    lower = (filename or "").lower()
    if not lower.endswith(SUPPORTED_EXTENSIONS):
        raise DocumentError("Please choose a PDF, Markdown or TXT file.")

    if lower.endswith(".pdf"):
        if not data[:1024].lstrip().startswith(b"%PDF-"):
            raise DocumentError("That file is named .pdf but is not a PDF.")
        return extract_pdf(data)

    text = _decode(data)
    if not text.strip():
        raise DocumentError("The file has no readable text.")
    kind = "markdown" if lower.endswith((".md", ".markdown")) else "text"
    return {"text": text, "pages": 1, "warnings": [], "kind": kind}
