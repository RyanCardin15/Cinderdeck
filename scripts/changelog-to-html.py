#!/usr/bin/env python3
"""Convert one CHANGELOG.md entry to the HTML Sparkle shows in its update window.

Usage: python3 scripts/changelog-to-html.py build/changelog.md > build/release-notes.html

Keeps plain bullets and product sections (Features, Bug Fixes, ...); drops pipeline
sections (Chore, Contributors, Distribution Notes) and trailing commit/PR references.
"""
import html
import re
import sys

SKIPPED_SECTIONS = {"chore", "contributors", "distribution notes"}
SECTION_TITLES = {"features": "✨ Features", "bug fixes": "🐛 Bug Fixes"}
FALLBACK = "<ul><li>Bug fixes and improvements</li></ul>"


def inline(text: str) -> str:
    text = re.sub(r"\s+\([0-9a-f]{7,40}\)$", "", text)  # trailing commit hash
    text = re.sub(r"\s*\(#\d+\)", "", text)  # pull request references
    text = html.escape(text.strip(), quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    return text


def convert(markdown: str) -> str:
    parts = []
    items = []
    title = None
    skipping = False

    def flush():
        if items:
            if title:
                parts.append(f"<h3>{html.escape(title, quote=False)}</h3>")
            parts.append("<ul>" + "".join(f"<li>{item}</li>" for item in items) + "</ul>")
            items.clear()

    for line in markdown.splitlines():
        heading = re.match(r"^#{2,4}\s+(.*)$", line)
        if heading:
            flush()
            name = heading.group(1).strip()
            skipping = name.lower() in SKIPPED_SECTIONS
            title = SECTION_TITLES.get(name.lower(), name)
            continue
        bullet = re.match(r"^[-*]\s+(.*)$", line)
        if bullet and not skipping:
            item = inline(bullet.group(1))
            if item:
                items.append(item)
    flush()
    return "".join(parts) or FALLBACK


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as source:
        sys.stdout.write(convert(source.read()))
