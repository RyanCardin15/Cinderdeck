#!/usr/bin/env python3
"""Check the owned product boundaries and local workspace dependency graph."""
import json
from pathlib import Path
import sys
import subprocess

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "agent-runtime"
errors = []

for workflow in (ROOT / ".github/workflows").glob("*"):
    if workflow.is_file() and workflow.suffix.lower() in (".yml", ".yaml"):
        errors.append(f"GitHub Actions workflows are disabled for this project: {workflow.relative_to(ROOT)}")

for obsolete in (
    ".repos", ".github", "apps/marketing", "infra", "packaging", "t3.json",
    "oxlint-plugin-t3code", "docs/deckhand/upstream-patches.json",
    "scripts/deckhand/upstream-maintenance.mjs", "scripts/install.sh", "scripts/install.ps1",
    "scripts/build-cli-archive.ts", "scripts/smoke-cli-archive.ts",
):
    if (RUNTIME / obsolete).exists():
        errors.append(f"Obsolete standalone product path: agent-runtime/{obsolete}")

manifests = [RUNTIME / "package.json", RUNTIME / "scripts/package.json"]
manifests += list((RUNTIME / "apps").glob("*/package.json"))
manifests += list((RUNTIME / "packages").glob("*/package.json"))
manifests += list((RUNTIME / "apps/mobile/modules").glob("*/package.json"))
manifests += list(RUNTIME.glob("oxlint-plugin-*/package.json"))
packages = {}
for path in manifests:
    data = json.loads(path.read_text())
    name = data["name"]
    if name in packages:
        errors.append(f"Duplicate workspace package: {name}")
    packages[name] = (path, data)
    if name == "t3" or name.startswith("@t3tools/"):
        errors.append(f"Inherited package identity: {path.relative_to(ROOT)}")

for path, data in packages.values():
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        for name, version in data.get(section, {}).items():
            if version.startswith("workspace:") and name not in packages:
                errors.append(f"Missing workspace dependency {name} in {path.relative_to(ROOT)}")

for required in ("@cinderdeck/server", "@cinderdeck/web", "@cinderdeck/desktop", "@cinderdeck/mobile"):
    if required not in packages:
        errors.append(f"Required Cinderdeck component missing: {required}")

server = packages["@cinderdeck/server"][1]
if not server.get("private") or "bin" in server or "build:exe" in server.get("scripts", {}):
    errors.append("The embedded server must remain private and have no standalone executable release.")

mobile = (RUNTIME / "apps/mobile/app.config.ts").read_text()
for inherited in ("owner:", "d763fcb8", "ARK85ZXQ4Z", "app.t3.codes", "u.expo.dev"):
    if inherited in mobile:
        errors.append(f"Inherited mobile deployment identity: {inherited}")
if "enabled: false" not in mobile:
    errors.append("Companion OTA updates must be disabled until an owned service is configured.")

for license_path in (ROOT / "LICENSE", RUNTIME / "LICENSE", ROOT / "NOTICE"):
    if not license_path.is_file():
        errors.append(f"Required license notice missing: {license_path.relative_to(ROOT)}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
subprocess.run([sys.executable, str(ROOT / "scripts/check-branding.py")], check=True)
print(f"Cinderdeck repository boundaries and {len(packages)} workspace packages verified.")
