#!/usr/bin/env bash
# setup-release-signing.sh — one-time setup so published releases update installed copies of Cinderdeck.
#
# Run on your Mac from the repository, with the GitHub CLI signed in (gh auth login):
#   ./scripts/setup-release-signing.sh [--yes] [--replace-key]
#
# 1. Creates Cinderdeck's Sparkle update signing key in your login keychain, or reuses it,
#    uploads the private key as the SPARKLE_PRIVATE_KEY Actions secret, and writes the public
#    key to Cinderdeck/Resources/Info.plist with signed updates switched on.
# 2. If the repository has no code-signing secret, creates the "Cinderdeck Self-Signed"
#    certificate and uploads SELF_SIGNED_CERT_P12 and SELF_SIGNED_CERT_PASSWORD.
#
# Private keys are never printed. Commit the Info.plist change afterwards.
set -euo pipefail
umask 077

REPO="${CINDERDECK_REPO:-RyanCardin15/Cinderdeck}"
KEY_ACCOUNT="${CINDERDECK_SPARKLE_KEY_ACCOUNT:-cinderdeck}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INFO_PLIST="$ROOT_DIR/Cinderdeck/Resources/Info.plist"
PACKAGE_RESOLVED="$ROOT_DIR/Cinderdeck.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
ASSUME_YES=0
REPLACE_KEY=0

usage() {
  cat <<USAGE
Usage: $0 [--yes] [--replace-key]
  --yes          Create and upload the self-signed certificate without asking.
  --replace-key  Replace an SUPublicEDKey already in Info.plist with this keychain's key.
                 Installed copies then accept the next update only through a matching code signature.
USAGE
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n▸ %s\n' "$*"; }
confirm() {
  [[ "$ASSUME_YES" == 1 ]] && return 0
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

while (($#)); do
  case "$1" in
    -y | --yes) ASSUME_YES=1 ;;
    --replace-key) REPLACE_KEY=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
  shift
done

[[ "$(uname -s)" == Darwin ]] || fail "Run this on macOS: the signing key is stored in your login keychain."
command -v gh >/dev/null || fail "GitHub CLI not found. Install it (brew install gh), then run 'gh auth login'."
gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not signed in. Run 'gh auth login'."
command -v python3 >/dev/null || fail "python3 is required (xcode-select --install)."
[[ -f "$INFO_PLIST" ]] || fail "Info.plist not found: $INFO_PLIST"

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# ---------------------------------------------------------------------------
# Sparkle's generate_keys: reuse a local build's copy, or download the pinned release.
# ---------------------------------------------------------------------------

find_generate_keys() {
  local candidate
  for candidate in \
    "$ROOT_DIR"/build/*/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_keys \
    "$HOME"/Library/Developer/Xcode/DerivedData/Cinderdeck-*/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_keys; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

step "Finding Sparkle's generate_keys"
if ! GENERATE_KEYS=$(find_generate_keys); then
  SPARKLE_VERSION=$(python3 - "$PACKAGE_RESOLVED" <<'PY'
import json, sys
pins = json.load(open(sys.argv[1]))["pins"]
print(next(pin["state"]["version"] for pin in pins if pin["identity"] == "sparkle"))
PY
  ) || fail "Could not read the Sparkle version from $PACKAGE_RESOLVED"
  echo "Downloading Sparkle $SPARKLE_VERSION tools…"
  curl -fsSL -o "$TEMP_DIR/sparkle.tar.xz" \
    "https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz" \
    || fail "Could not download Sparkle $SPARKLE_VERSION."
  mkdir "$TEMP_DIR/sparkle"
  tar -xf "$TEMP_DIR/sparkle.tar.xz" -C "$TEMP_DIR/sparkle"
  GENERATE_KEYS=$(find "$TEMP_DIR/sparkle" -type f -name generate_keys -perm -u+x | head -n 1)
  [[ -n "$GENERATE_KEYS" ]] || fail "generate_keys is missing from the Sparkle $SPARKLE_VERSION download."
fi
codesign --verify --strict "$GENERATE_KEYS" 2>/dev/null || fail "generate_keys has an invalid code signature: $GENERATE_KEYS"
echo "Using $GENERATE_KEYS"

# ---------------------------------------------------------------------------
# Update signing key
# ---------------------------------------------------------------------------

step "Update signing key (keychain account '$KEY_ACCOUNT')"
echo "macOS may ask to let generate_keys use your keychain; allow it."
# Creates a key only when the account has none; an existing key is never replaced.
"$GENERATE_KEYS" --account "$KEY_ACCOUNT" >/dev/null
PUBLIC_KEY=$("$GENERATE_KEYS" --account "$KEY_ACCOUNT" -p | tail -n 1 | tr -d '[:space:]')
[[ "$(printf '%s' "$PUBLIC_KEY" | base64 -D 2>/dev/null | wc -c | tr -d ' ')" == 32 ]] \
  || fail "generate_keys returned an unexpected public key: $PUBLIC_KEY"

CURRENT_KEY=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$INFO_PLIST" 2>/dev/null || true)
if [[ -n "$CURRENT_KEY" && "$CURRENT_KEY" != "$PUBLIC_KEY" && "$REPLACE_KEY" != 1 ]]; then
  fail "Info.plist trusts a different key ($CURRENT_KEY) than keychain account '$KEY_ACCOUNT' ($PUBLIC_KEY).
Import the original private key with: $GENERATE_KEYS --account $KEY_ACCOUNT -f <exported-key-file>
or rerun with --replace-key if no release signed with the old key needs to keep updating."
fi

KEY_FILE="$TEMP_DIR/sparkle-private-key"
"$GENERATE_KEYS" --account "$KEY_ACCOUNT" -x "$KEY_FILE" >/dev/null
gh secret set SPARKLE_PRIVATE_KEY --repo "$REPO" < "$KEY_FILE"
rm -f "$KEY_FILE"
echo "Uploaded SPARKLE_PRIVATE_KEY to $REPO."

# Edit the XML in place so the rest of Info.plist keeps its order and formatting.
python3 - "$INFO_PLIST" "$PUBLIC_KEY" <<'PY'
import re
import sys

path, key = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
text = re.sub(r"(<key>CinderdeckSignedUpdatesEnabled</key>\s*)<false/>", r"\1<true/>", text)
existing = re.compile(r"(<key>SUPublicEDKey</key>\s*<string>)[^<]*(</string>)")
if existing.search(text):
    text = existing.sub(lambda match: match.group(1) + key + match.group(2), text)
else:
    feed = re.compile(r"(\t<key>SUFeedURL</key>\n\t<string>[^<]*</string>\n)")
    if not feed.search(text):
        sys.exit("SUFeedURL entry not found in Info.plist")
    text = feed.sub(lambda match: match.group(1) + "\t<key>SUPublicEDKey</key>\n\t<string>" + key + "</string>\n", text, count=1)
open(path, "w", encoding="utf-8").write(text)
PY
plutil -lint "$INFO_PLIST" >/dev/null || fail "Info.plist is no longer valid; restore it with git checkout."
[[ "$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$INFO_PLIST")" == "$PUBLIC_KEY" ]] \
  || fail "SUPublicEDKey was not written to Info.plist."
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CinderdeckSignedUpdatesEnabled' "$INFO_PLIST")" == true ]] \
  || fail "CinderdeckSignedUpdatesEnabled is not true in Info.plist."
echo "Info.plist now trusts $PUBLIC_KEY and has signed updates switched on."

# ---------------------------------------------------------------------------
# Code-signing certificate for release builds
# ---------------------------------------------------------------------------

step "Release code-signing certificate"
SECRETS=$(gh secret list --repo "$REPO" | awk '{ print $1 }')
has_secret() { grep -qx "$1" <<<"$SECRETS"; }

if has_secret DEVELOPER_ID_P12 || has_secret SELF_SIGNED_CERT_P12; then
  echo "A code-signing secret already exists in $REPO; leaving it unchanged."
elif confirm "No code-signing secret found. Create the 'Cinderdeck Self-Signed' certificate and upload it?"; then
  P12_PASSWORD=$(uuidgen)
  CERT_OUTPUT=$(CINDERDECK_P12_PASSWORD="$P12_PASSWORD" "$ROOT_DIR/scripts/create-signing-cert.sh")
  P12_BASE64=$(printf '%s\n' "$CERT_OUTPUT" \
    | sed -n '/^--- BEGIN BASE64 ---$/,/^--- END BASE64 ---$/p' | sed '1d;$d' | tr -d '\n')
  if [[ -z "$P12_BASE64" ]]; then
    cat <<EXPORT
The 'Cinderdeck Self-Signed' identity already exists in your keychain, so nothing new was exported.
Export it from Keychain Access (My Certificates > Cinderdeck Self-Signed > Export) as a .p12, then run:
  base64 -i Cinderdeck-Self-Signed.p12 | gh secret set SELF_SIGNED_CERT_P12 --repo $REPO
  gh secret set SELF_SIGNED_CERT_PASSWORD --repo $REPO
EXPORT
  else
    printf '%s' "$P12_BASE64" | gh secret set SELF_SIGNED_CERT_P12 --repo "$REPO"
    printf '%s' "$P12_PASSWORD" | gh secret set SELF_SIGNED_CERT_PASSWORD --repo "$REPO"
    echo "Uploaded SELF_SIGNED_CERT_P12 and SELF_SIGNED_CERT_PASSWORD to $REPO."
  fi
else
  echo "Skipped. Releases need DEVELOPER_ID_P12 or SELF_SIGNED_CERT_P12 secrets; see docs/SELF_SIGNED_CERT.md."
fi

cat <<NEXT

Done. Next:
  1. Commit and merge the Info.plist change:
       git add Cinderdeck/Resources/Info.plist
       git commit -m "Enable signed automatic updates"
  2. After it is on main, publish a release and merge the release pull request it opens:
       gh workflow run release-prepare.yml --repo $REPO -f version_type=patch -f channel=stable
  3. Back up the signing key. Keychain Access lists it as "Private key for signing Sparkle updates"
     (account '$KEY_ACCOUNT'). Without it, new releases cannot update copies already installed.
NEXT
