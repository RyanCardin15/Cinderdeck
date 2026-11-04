#!/usr/bin/env python3
"""Verify the app identities and artwork shipped with the Cinderdeck fork."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "agent-runtime"


def branding_errors(root):
    errors = []
    for file, field in [
        ("apps/desktop/package.json", "productName"),
        ("apps/web/public/manifest.webmanifest", "name"),
        ("apps/web/public/manifest.webmanifest", "short_name"),
    ]:
        if json.loads((root / file).read_text()).get(field) != "Cinderdeck":
            errors.append(f"{file} must identify the app as Cinderdeck ({field})")
    for source, target in [
        ("ios-1024.png", "assets/prod/black-ios-1024.png"),
        ("macos-1024.png", "assets/prod/black-macos-1024.png"),
        ("web-apple-touch-180.png", "apps/web/public/apple-touch-icon.png"),
        ("web-favicon.ico", "apps/web/public/favicon.ico"),
    ]:
        if (root / "assets/cinderdeck/prod" / source).read_bytes() != (root / target).read_bytes():
            errors.append(f"{target} must use Cinderdeck artwork")
    return errors


if __name__ == "__main__":
    failures = branding_errors(ROOT)
    if failures:
        raise SystemExit("\n".join(failures))
    print("Cinderdeck app identity and artwork verified.")
