#!/usr/bin/env python3
"""Extract plain text from uploaded source documents."""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree


class HtmlTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
        if tag in {"p", "br", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4"}:
            self._chunks.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
        if tag in {"p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4"}:
            self._chunks.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        value = html.unescape(data).strip()
        if value:
            self._chunks.append(value)

    def text(self) -> str:
        return normalize_text(" ".join(self._chunks))


def normalize_text(value: str) -> str:
    value = value.replace("\u0000", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r"\n\s+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def extract_docx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    paragraphs: list[str] = []
    for paragraph in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"):
        text = "".join(node.text or "" for node in paragraph.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"))
        if text.strip():
            paragraphs.append(text.strip())
    return normalize_text("\n".join(paragraphs))


def shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    strings: list[str] = []
    for item in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si"):
        strings.append("".join(node.text or "" for node in item.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
    return strings


def extract_xlsx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        strings = shared_strings(archive)
        sheet_names = sorted(name for name in archive.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", name))
        rows: list[str] = []
        for sheet_name in sheet_names:
            root = ElementTree.fromstring(archive.read(sheet_name))
            rows.append(f"# {Path(sheet_name).stem}")
            for row in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"):
                values: list[str] = []
                for cell in row.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
                    value_node = cell.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v")
                    if value_node is None or value_node.text is None:
                        continue
                    value = value_node.text
                    if cell.attrib.get("t") == "s":
                        try:
                            value = strings[int(value)]
                        except (IndexError, ValueError):
                            pass
                    values.append(value)
                if values:
                    rows.append(" | ".join(values))
    return normalize_text("\n".join(rows))


def extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pypdf is required to extract PDF text.") from exc
    reader = PdfReader(str(path))
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        if text.strip():
            pages.append(f"# Page {index}\n{text.strip()}")
    return normalize_text("\n\n".join(pages))


def extract_csv(path: Path) -> str:
    lines = []
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        for row in csv.reader(handle):
            if any(cell.strip() for cell in row):
                lines.append(" | ".join(cell.strip() for cell in row))
    return normalize_text("\n".join(lines))


def extract_html(path: Path) -> str:
    parser = HtmlTextParser()
    parser.feed(path.read_text(encoding="utf-8", errors="replace"))
    return parser.text()


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".markdown", ".log"}:
        return normalize_text(path.read_text(encoding="utf-8", errors="replace"))
    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        return normalize_text(json.dumps(payload, ensure_ascii=False, indent=2))
    if suffix == ".csv":
        return extract_csv(path)
    if suffix in {".html", ".htm"}:
        return extract_html(path)
    if suffix == ".docx":
        return extract_docx(path)
    if suffix == ".xlsx":
        return extract_xlsx(path)
    if suffix == ".pdf":
        return extract_pdf(path)
    raise ValueError(f"Unsupported file type: {suffix}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Extract text from an uploaded document.")
    parser.add_argument("file")
    args = parser.parse_args(argv)
    text = extract_text(Path(args.file).expanduser())
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
