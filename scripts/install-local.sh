#!/usr/bin/env bash
# Build and install Release with a persistent certificate-based identity.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA_PATH="${CINDERDECK_DERIVED_DATA_PATH:-$ROOT_DIR/.build/local-install}"
SIGNING_IDENTITY="${CINDERDECK_SIGNING_IDENTITY:-Cinderdeck Local Development}"
KEYCHAIN="${CINDERDECK_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
INSTALL_PATH="/Applications/Cinderdeck.app"
BUNDLE_ID="com.ryancardin.cinderdeck"
RESET_PERMISSIONS=0
BUILD_ONLY=0
LAUNCH=1
STAGING_DIR=""

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<HELP
Usage: $0 [--reset-permissions] [--build-only] [--no-launch]

Build Release, sign with a persistent local identity, verify, and install to
/Applications/Cinderdeck.app. Creates the identity once if needed.

  --reset-permissions  Reset only Cinderdeck's Screen Recording and Accessibility
                       grants after installing. Use once when replacing ad-hoc signing.
  --build-only         Build and verify without installing, resetting TCC, or opening UI.
  --no-launch          Install without launching the app.

Environment:
  CINDERDECK_SIGNING_IDENTITY    Exact certificate name or SHA-1 fingerprint.
                                Default: Cinderdeck Local Development (auto-created).
  CINDERDECK_SIGNING_KEYCHAIN    Default: ~/Library/Keychains/login.keychain-db
  CINDERDECK_DERIVED_DATA_PATH   Default: .build/local-install
HELP
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset-permissions) RESET_PERMISSIONS=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --no-launch) LAUNCH=0 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
[[ "$(uname -s)" == Darwin ]] || fail "This script requires macOS."
[[ "$SIGNING_IDENTITY" != - && -n "$SIGNING_IDENTITY" ]] || fail "Ad-hoc signing is not supported for local installs."
[[ "$BUILD_ONLY" == 0 || "$RESET_PERMISSIONS" == 0 ]] || fail "--reset-permissions cannot be combined with --build-only."

if [[ "$SIGNING_IDENTITY" == "Cinderdeck Local Development" ]]; then
  "$ROOT_DIR/scripts/create-signing-cert.sh" --local "$SIGNING_IDENTITY"
fi
IDENTITIES=$(security find-identity -v -p codesigning "$KEYCHAIN")
SIGNING_HASH=$(printf '%s\n' "$IDENTITIES" | awk -F '"' -v identity="$SIGNING_IDENTITY" '
  { split($1, fields, " "); if ($2 == identity || toupper(fields[2]) == toupper(identity)) print fields[2] }')
[[ -n "$SIGNING_HASH" ]] || fail "No valid signing identity '$SIGNING_IDENTITY' in $KEYCHAIN. Unlock the keychain and check its certificate, private key, and trust."
[[ "$SIGNING_HASH" != *$'\n'* ]] || fail "Ambiguous signing identity '$SIGNING_IDENTITY'; use its SHA-1 fingerprint."
[[ "$SIGNING_HASH" =~ ^[A-Fa-f0-9]{40}$ ]] || fail "Invalid signing fingerprint."

mkdir -p "$DERIVED_DATA_PATH"
DERIVED_DATA_PATH="$(cd "$DERIVED_DATA_PATH" && pwd)"
APP_PATH="$DERIVED_DATA_PATH/Build/Products/Release/Cinderdeck.app"
BUILD_LOG="$DERIVED_DATA_PATH/install-local.log"
echo "Building Release. Log: $BUILD_LOG"
# Keep the existing Xcode 26.3 performance-inliner workaround from docs/BUILD.md.
# Sign inside-out below so Sparkle helpers and the app use the same identity.
if ! xcodebuild -project "$ROOT_DIR/Cinderdeck.xcodeproj" -scheme Cinderdeck \
  -configuration Release -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  CODE_SIGN_IDENTITY= CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  'OTHER_SWIFT_FLAGS=$(inherited) -Xllvm -sil-disable-pass=PerfInliner' \
  build > "$BUILD_LOG" 2>&1; then
  tail -60 "$BUILD_LOG" >&2
  fail "Build failed; the installed app and its permissions have not been changed."
fi
[[ -d "$APP_PATH" ]] || fail "Built app missing: $APP_PATH"
ACTUAL_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Contents/Info.plist")
[[ "$ACTUAL_BUNDLE_ID" == "$BUNDLE_ID" ]] || fail "Unexpected bundle identifier: $ACTUAL_BUNDLE_ID"

sign() {
  codesign --force --sign "$SIGNING_HASH" --keychain "$KEYCHAIN" \
    --options runtime --timestamp=none "$@"
}
SPARKLE="$APP_PATH/Contents/Frameworks/Sparkle.framework"
[[ -d "$SPARKLE" ]] || fail "Expected Sparkle.framework is missing."
sign "$SPARKLE/Versions/B/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$SPARKLE/Versions/B/XPCServices/Downloader.xpc"
sign "$SPARKLE/Versions/B/Autoupdate"
sign "$SPARKLE/Versions/B/Updater.app"
sign "$SPARKLE"
# codesign does not expand Xcode variables in entitlements itself.
ENTITLEMENTS="$DERIVED_DATA_PATH/local-entitlements.plist"
sed 's/$(PRODUCT_BUNDLE_IDENTIFIER)/com.ryancardin.cinderdeck/g' \
  "$ROOT_DIR/Cinderdeck/Cinderdeck.entitlements" > "$ENTITLEMENTS"
# Self-signed certificates have no Apple Team ID. Hardened runtime otherwise
# refuses to load Sparkle, even when both binaries use the same certificate.
# Keep library validation enabled for Apple-issued signing identities.
if ! codesign --verify --strict -R='anchor apple generic' "$SPARKLE" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.disable-library-validation bool true' "$ENTITLEMENTS"
fi
sign --entitlements "$ENTITLEMENTS" "$APP_PATH"

verify() {
  codesign --verify --deep --strict "$1" || return 1
  local requirement
  requirement=$(codesign -dr - "$1" 2>&1 | sed -n 's/^designated => //p')
  if [[ -z "$requirement" || "$requirement" == *cdhash* || ( "$requirement" != *certificate* && "$requirement" != *anchor* ) ]]; then
    printf 'Error: Signature has no certificate-based designated requirement: %s\n' "$requirement" >&2
    return 1
  fi
  printf '%s\n' "$requirement"
}
REQUIREMENT=$(verify "$APP_PATH")
printf '%s\n' "$REQUIREMENT" > "$DERIVED_DATA_PATH/designated-requirement.txt"
echo "Verified designated requirement: $REQUIREMENT"
# This CLI command exits before migration, app initialization, or permission UI.
# A valid signature alone cannot detect a dyld / hardened-runtime launch failure.
if ! "$APP_PATH/Contents/MacOS/Cinderdeck" stacks help > "$DERIVED_DATA_PATH/launch-check.log" 2>&1; then
  cat "$DERIVED_DATA_PATH/launch-check.log" >&2
  fail "Signed app could not launch; the installed app and its permissions have not been changed."
fi
if [[ "$BUILD_ONLY" == 1 ]]; then
  echo "Signed app ready: $APP_PATH"
  exit 0
fi

# Stage and verify on the destination volume before stopping the installed app.
# Roll back a failed replacement; keep the prior installation as a local backup.
cleanup() {
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
    if [[ -d "$STAGING_DIR/previous.app" ]]; then
      if [[ ! -e "$INSTALL_PATH" ]]; then
        if ! mv "$STAGING_DIR/previous.app" "$INSTALL_PATH"; then
          echo "Could not restore the previous installation; it is retained at $STAGING_DIR/previous.app" >&2
          return
        fi
      else
        echo "Previous installation retained at $STAGING_DIR/previous.app"
        return
      fi
    fi
    rm -rf "$STAGING_DIR"
  fi
}
trap cleanup EXIT
STAGING_DIR=$(mktemp -d /Applications/.cinderdeck-install.XXXXXX) \
  || fail "Cannot write to /Applications. Run from an account with access; do not run this script with sudo."
ditto "$APP_PATH" "$STAGING_DIR/Cinderdeck.app"
verify "$STAGING_DIR/Cinderdeck.app" >/dev/null
# Ask the Release app to quit normally so capture/editor work can be saved.
if pgrep -f '^/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck([[:space:]]|$)' >/dev/null; then
  osascript -e 'tell application id "com.ryancardin.cinderdeck" to quit'
  for ((attempt = 0; attempt < 20; attempt++)); do
    if ! pgrep -f '^/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck([[:space:]]|$)' >/dev/null; then break; fi
    sleep 0.5
  done
  if pgrep -f '^/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck([[:space:]]|$)' >/dev/null; then
    fail "Cinderdeck is still running. Quit it before installing again."
  fi
fi
if [[ -e "$INSTALL_PATH" ]]; then mv "$INSTALL_PATH" "$STAGING_DIR/previous.app"; fi
if ! mv "$STAGING_DIR/Cinderdeck.app" "$INSTALL_PATH"; then
  fail "Could not replace $INSTALL_PATH."
fi
if ! verify "$INSTALL_PATH" >/dev/null; then
  rm -rf "$INSTALL_PATH"
  fail "Installed signature verification failed; restoring the previous installation."
fi
echo "Installed $INSTALL_PATH"

if [[ "$RESET_PERMISSIONS" == 1 ]]; then
  tccutil reset ScreenCapture "$BUNDLE_ID"
  tccutil reset Accessibility "$BUNDLE_ID"
  echo "Grant Screen Recording and Accessibility once in System Settings, then quit and reopen Cinderdeck."
else
  echo "Existing TCC grants left in place. When migrating from ad-hoc signing, run once with --reset-permissions."
fi
if [[ "$LAUNCH" == 1 ]]; then open "$INSTALL_PATH"; fi
