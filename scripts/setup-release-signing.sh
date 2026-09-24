#!/usr/bin/env bash
# setup-release-signing.sh — one command that turns on automatic updates and publishes a release.
#
# Run on your Mac from the repository, with the GitHub CLI signed in (gh auth login):
#   ./scripts/setup-release-signing.sh [--yes] [--bump patch|minor|major] [--no-release] [--replace-key]
#
# 1. Creates Cinderdeck's Sparkle update signing key in your login keychain, or reuses it,
#    and uploads the private key as the SPARKLE_PRIVATE_KEY Actions secret.
# 2. If the repository has no code-signing secret, creates the "Cinderdeck Self-Signed"
#    certificate and uploads SELF_SIGNED_CERT_P12 and SELF_SIGNED_CERT_PASSWORD.
# 3. Commits the public key (SUPublicEDKey) and CinderdeckSignedUpdatesEnabled to main.
# 4. Runs Release Prepare and opens its release pull request if GitHub Actions could not.
#    After you review and merge that pull request on GitHub, follows Release Publish and
#    offers to install the new release on this Mac.
#
# Each step that changes GitHub asks first (unless --yes). Private keys are never printed.
set -euo pipefail
umask 077

REPO="${CINDERDECK_REPO:-RyanCardin15/Cinderdeck}"
KEY_ACCOUNT="${CINDERDECK_SPARKLE_KEY_ACCOUNT:-cinderdeck}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_PATH="Cinderdeck/Resources/Info.plist"
PACKAGE_RESOLVED="$ROOT_DIR/Cinderdeck.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
ASSUME_YES=0
REPLACE_KEY=0
RELEASE=1
BUMP="minor"

usage() {
  cat <<USAGE
Usage: $0 [--yes] [--bump patch|minor|major] [--no-release] [--replace-key]
  --yes          Answer yes to every question.
  --bump TYPE    Version bump for the release (default: minor).
  --no-release   Stop after configuring signing; publish later with the Release Prepare workflow.
  --replace-key  Replace an SUPublicEDKey already on main with this keychain's key.
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
    --no-release) RELEASE=0 ;;
    --bump)
      [[ $# -ge 2 ]] || { usage >&2; exit 1; }
      BUMP="$2"
      shift
      ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
  shift
done
case "$BUMP" in patch | minor | major) ;; *) fail "--bump must be patch, minor, or major." ;; esac

[[ "$(uname -s)" == Darwin ]] || fail "Run this on macOS: the signing key is stored in your login keychain."
command -v gh >/dev/null || fail "GitHub CLI not found. Install it (brew install gh), then run 'gh auth login'."
gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not signed in. Run 'gh auth login'."
command -v python3 >/dev/null || fail "python3 is required (xcode-select --install)."

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
echo "Public key: $PUBLIC_KEY"

# Main's Info.plist, edited through the GitHub API so any local checkout works.
REMOTE_PLIST="$TEMP_DIR/Info.plist"
PLIST_SHA=$(gh api "repos/$REPO/contents/$PLIST_PATH?ref=main" --jq .sha)
gh api "repos/$REPO/contents/$PLIST_PATH?ref=main" -H "Accept: application/vnd.github.raw" > "$REMOTE_PLIST"
CURRENT_KEY=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$REMOTE_PLIST" 2>/dev/null || true)
if [[ -n "$CURRENT_KEY" && "$CURRENT_KEY" != "$PUBLIC_KEY" && "$REPLACE_KEY" != 1 ]]; then
  fail "main trusts a different key ($CURRENT_KEY) than keychain account '$KEY_ACCOUNT' ($PUBLIC_KEY).
Import the original private key with: $GENERATE_KEYS --account $KEY_ACCOUNT -f <exported-key-file>
or rerun with --replace-key if no release signed with the old key needs to keep updating."
fi

KEY_FILE="$TEMP_DIR/sparkle-private-key"
"$GENERATE_KEYS" --account "$KEY_ACCOUNT" -x "$KEY_FILE" >/dev/null
gh secret set SPARKLE_PRIVATE_KEY --repo "$REPO" < "$KEY_FILE"
rm -f "$KEY_FILE"
echo "Uploaded SPARKLE_PRIVATE_KEY to $REPO."

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
    fail "The 'Cinderdeck Self-Signed' identity already exists in your keychain, so nothing new was exported.
Export it from Keychain Access (My Certificates > Cinderdeck Self-Signed > Export) as a .p12, then run:
  base64 -i Cinderdeck-Self-Signed.p12 | gh secret set SELF_SIGNED_CERT_P12 --repo $REPO
  gh secret set SELF_SIGNED_CERT_PASSWORD --repo $REPO
and run this script again."
  fi
  printf '%s' "$P12_BASE64" | gh secret set SELF_SIGNED_CERT_P12 --repo "$REPO"
  printf '%s' "$P12_PASSWORD" | gh secret set SELF_SIGNED_CERT_PASSWORD --repo "$REPO"
  echo "Uploaded SELF_SIGNED_CERT_P12 and SELF_SIGNED_CERT_PASSWORD to $REPO."
else
  fail "Releases need DEVELOPER_ID_P12 or SELF_SIGNED_CERT_P12 secrets; see docs/SELF_SIGNED_CERT.md."
fi

# ---------------------------------------------------------------------------
# Trust the key on main
# ---------------------------------------------------------------------------

step "Signed updates on main"
cp "$REMOTE_PLIST" "$TEMP_DIR/Info.before.plist"
# Edit the XML in place so the rest of Info.plist keeps its order and formatting.
python3 - "$REMOTE_PLIST" "$PUBLIC_KEY" <<'PY'
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
plutil -lint "$REMOTE_PLIST" >/dev/null || fail "The edited Info.plist is invalid."
[[ "$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$REMOTE_PLIST")" == "$PUBLIC_KEY" ]] \
  || fail "SUPublicEDKey was not written."
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CinderdeckSignedUpdatesEnabled' "$REMOTE_PLIST")" == true ]] \
  || fail "CinderdeckSignedUpdatesEnabled is not true."

if cmp -s "$REMOTE_PLIST" "$TEMP_DIR/Info.before.plist"; then
  echo "main already trusts this key and has signed updates switched on."
elif confirm "Commit SUPublicEDKey and CinderdeckSignedUpdatesEnabled to main?"; then
  COMMIT_URL=$(gh api -X PUT "repos/$REPO/contents/$PLIST_PATH" \
    -f message="Enable signed automatic updates" \
    -f content="$(base64 -i "$REMOTE_PLIST" | tr -d '\n')" \
    -f sha="$PLIST_SHA" -f branch=main --jq .commit.html_url)
  echo "Committed: $COMMIT_URL"
  echo "Run 'git pull' on main to get it locally."
else
  cp "$REMOTE_PLIST" "$ROOT_DIR/$PLIST_PATH"
  echo "Wrote $PLIST_PATH locally instead. Commit it to main before releasing."
  RELEASE=0
fi

# ---------------------------------------------------------------------------
# First release
# ---------------------------------------------------------------------------

# Prints the id of the newest run of a workflow created at or after $2.
newest_run_since() {
  local workflow="$1" since="$2" run_id
  for _ in $(seq 1 40); do
    run_id=$(gh run list --repo "$REPO" --workflow "$workflow" --limit 5 \
      --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$since\")][0].databaseId // empty")
    if [[ -n "$run_id" ]]; then
      printf '%s\n' "$run_id"
      return 0
    fi
    sleep 3
  done
  return 1
}

watch_run() {
  local run_id="$1" name="$2"
  echo "Following $name: https://github.com/$REPO/actions/runs/$run_id"
  if ! gh run watch "$run_id" --repo "$REPO" --exit-status --interval 15 >/dev/null; then
    gh run view "$run_id" --repo "$REPO" --log-failed | tail -n 60 >&2 || true
    fail "$name failed. Details: https://github.com/$REPO/actions/runs/$run_id"
  fi
  echo "$name finished."
}

if [[ "$RELEASE" == 1 ]] && confirm "Prepare a $BUMP release now?"; then
  step "Release"
  # The version Release Prepare will choose, from main's project file and the same bump script.
  mkdir -p "$TEMP_DIR/bump/Cinderdeck.xcodeproj"
  gh api "repos/$REPO/contents/Cinderdeck.xcodeproj/project.pbxproj?ref=main" -H "Accept: application/vnd.github.raw" \
    > "$TEMP_DIR/bump/Cinderdeck.xcodeproj/project.pbxproj"
  NEXT_VERSION=$(cd "$TEMP_DIR/bump" && bash "$ROOT_DIR/scripts/bump-version.sh" "$BUMP" stable | sed -n 's/^version=//p')
  [[ -n "$NEXT_VERSION" ]] || fail "Could not work out the next version."
  RELEASE_BRANCH="release/v$NEXT_VERSION"
  echo "Preparing v$NEXT_VERSION."

  # 30 seconds of slack for clock differences between this Mac and GitHub.
  STARTED=$(date -u -v-30S +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run release-prepare.yml --repo "$REPO" -f version_type="$BUMP" -f channel=stable
  PREPARE_RUN=$(newest_run_since release-prepare.yml "$STARTED") || fail "Release Prepare did not start."
  watch_run "$PREPARE_RUN" "Release Prepare"

  RELEASE_PR=$(gh pr list --repo "$REPO" --head "$RELEASE_BRANCH" --state open --json number --jq '.[0].number // empty')
  if [[ -z "$RELEASE_PR" ]]; then
    # GitHub Actions may not be allowed to create pull requests; open it with your login instead.
    gh api "repos/$REPO/branches/$RELEASE_BRANCH" --jq .name >/dev/null 2>&1 \
      || fail "Release Prepare finished but $RELEASE_BRANCH does not exist."
    gh pr create --repo "$REPO" --base main --head "$RELEASE_BRANCH" --title "chore: release v$NEXT_VERSION" \
      --body "Publishes v$NEXT_VERSION. Release notes are the v$NEXT_VERSION entry in CHANGELOG.md."
    RELEASE_PR=$(gh pr list --repo "$REPO" --head "$RELEASE_BRANCH" --state open --json number --jq '.[0].number // empty')
    [[ -n "$RELEASE_PR" ]] || fail "Could not open a pull request for $RELEASE_BRANCH."
  fi

  echo
  echo "Review and merge the release pull request to publish v$NEXT_VERSION:"
  echo "  https://github.com/$REPO/pull/$RELEASE_PR"
  echo "Waiting for it to be merged (Ctrl-C to stop; Release Publish still runs when it merges)…"
  while :; do
    PR_STATE=$(gh pr view "$RELEASE_PR" --repo "$REPO" --json state --jq .state)
    [[ "$PR_STATE" == OPEN ]] || break
    sleep 15
  done
  [[ "$PR_STATE" == MERGED ]] || fail "Release pull request #$RELEASE_PR was closed without merging."
  MERGED_AT=$(gh pr view "$RELEASE_PR" --repo "$REPO" --json mergedAt --jq .mergedAt)

  PUBLISH_RUN=$(newest_run_since release-publish.yml "$MERGED_AT") || fail "Release Publish did not start."
  watch_run "$PUBLISH_RUN" "Release Publish"

  TAG=$(gh release view --repo "$REPO" --json tagName --jq .tagName)
  echo "Published $TAG: https://github.com/$REPO/releases/tag/$TAG"

  if confirm "Install $TAG into /Applications on this Mac? Copies built before now cannot update themselves."; then
    osascript -e 'tell application id "com.ryancardin.cinderdeck" to quit' >/dev/null 2>&1 || true
    sleep 3
    VERSION="$TAG" bash "$ROOT_DIR/install.sh"
    open -b com.ryancardin.cinderdeck || true
  fi
fi

cat <<NEXT

Done. Back up the signing key: Keychain Access lists it as "Private key for signing Sparkle updates"
(account '$KEY_ACCOUNT'). Without it, new releases cannot update copies already installed.
Future releases: run Release Prepare (Actions tab) and merge the pull request it opens.
NEXT
