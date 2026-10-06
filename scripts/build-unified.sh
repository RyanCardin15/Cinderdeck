#!/usr/bin/env bash
# Assemble a single native Cinderdeck app; never install, launch, or create certificates.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_SOURCE="$ROOT_DIR/agent-runtime"
OUTPUT_DIR=""
CONFIGURATION="Debug"
RUNTIME_APP=""
NATIVE_APP=""
NATIVE_DERIVED_DATA="$ROOT_DIR/.build/unified-native"
ARCH="$(uname -m)"
[[ "$ARCH" != x86_64 ]] || ARCH=x64
SIGNING_IDENTITY="${CINDERDECK_SIGNING_IDENTITY:-}"
KEYCHAIN="${CINDERDECK_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
NODE_BINARY="${CINDERDECK_NODE_BINARY:-}"
DRY_RUN=0
STAGING_DIR=""
COMPLETE=0
RUNTIME_CACHE="${CINDERDECK_RUNTIME_CACHE:-1}"
RUNTIME_CACHE_DIR="$ROOT_DIR/.build/runtime-cache"
RUNTIME_CACHE_KEY=""
RUNTIME_PID=""

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<HELP
Usage: $0 --output-dir /absolute/output \\
  --configuration Debug|Release [options]

Build and assemble one Cinderdeck app containing Resources/Cinderdeck.app.
Does not install, launch, reset permissions, create certificates, or publish.

  --runtime-source /absolute/checkout   Override the included agent-runtime source.
  --derived-data /absolute/path         Native build cache (default .build/unified-native).
  --runtime-app /absolute/Cinderdeck.app  Reuse this internal runtime app.
  --native-app /absolute/native.app      Reuse this native build.
  --arch arm64|x64|universal             Default: host architecture.
  --signing-identity NAME|SHA1           Exact existing certificate identity.
                                         Release requires it; Debug defaults to ad-hoc.
  --no-runtime-cache                    Rebuild the runtime even when a Debug build from
                                         identical runtime inputs is cached.
  --dry-run                             Validate inputs and print the build plan only.

The runtime and native app build in parallel. Debug builds reuse a cached
runtime (.build/runtime-cache) when the runtime sources, ignored .env
files, toolchains, build environment and Git metadata it embeds are unchanged.

Environment:
  CINDERDECK_NODE_BINARY       Absolute Node 24.13.1+ executable for runtime builds.
  CINDERDECK_SIGNING_IDENTITY  Same as --signing-identity; no automatic identity creation.
  CINDERDECK_SIGNING_KEYCHAIN  Existing signing keychain; default login.keychain-db.
  CINDERDECK_RUNTIME_CACHE     Set to 0 to behave like --no-runtime-cache.

Existing output apps are never replaced. Debug ad-hoc output is for manual checks.
HELP
}
require_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "Missing value for $1"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-source) require_value "$@"; RUNTIME_SOURCE=$2; shift ;;
    --derived-data) require_value "$@"; NATIVE_DERIVED_DATA=$2; shift ;;
    --output-dir) require_value "$@"; OUTPUT_DIR=$2; shift ;;
    --configuration) require_value "$@"; CONFIGURATION=$2; shift ;;
    --runtime-app) require_value "$@"; RUNTIME_APP=$2; shift ;;
    --native-app) require_value "$@"; NATIVE_APP=$2; shift ;;
    --arch) require_value "$@"; ARCH=$2; shift ;;
    --signing-identity) require_value "$@"; SIGNING_IDENTITY=$2; shift ;;
    --no-runtime-cache) RUNTIME_CACHE=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
[[ "$(uname -s)" == Darwin ]] || fail "This command requires macOS."
[[ "$CONFIGURATION" == Debug || "$CONFIGURATION" == Release ]] || fail "Pass --configuration Debug or Release."
[[ "$ARCH" == arm64 || "$ARCH" == x64 || "$ARCH" == universal ]] || fail "Unsupported architecture: $ARCH"
[[ "$RUNTIME_SOURCE" == /* && -d "$RUNTIME_SOURCE" ]] || fail "Pass an absolute existing --runtime-source checkout."
RUNTIME_SOURCE="$(cd "$RUNTIME_SOURCE" && pwd -P)"
[[ -f "$RUNTIME_SOURCE/scripts/build-desktop-artifact.ts" ]] || fail "Runtime checkout lacks its desktop artifact builder."
[[ "$OUTPUT_DIR" == /* && "$OUTPUT_DIR" != / ]] || fail "Pass a non-root absolute --output-dir."
# Resolve '..' and existing symlink ancestors before refusing installed application locations.
OUTPUT_DIR="$(python3 - "$OUTPUT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
[[ "$OUTPUT_DIR" != / ]] || fail "Output must not resolve to the filesystem root."
case "$OUTPUT_DIR/" in
  /Applications/*|/System/Applications/*|/System/Volumes/Data/Applications/*|"$HOME/Applications/"*) fail "Use a delivery directory, not an Applications installation location." ;;
esac

if [[ "$CONFIGURATION" == Debug ]]; then
  APP_NAME="Cinderdeck Debug.app"
  BUNDLE_ID="com.ryancardin.cinderdeck.debug"
  [[ -n "$SIGNING_IDENTITY" ]] || SIGNING_IDENTITY=-
else
  APP_NAME="Cinderdeck.app"
  BUNDLE_ID="com.ryancardin.cinderdeck"
  [[ -n "$SIGNING_IDENTITY" && ( "$SIGNING_IDENTITY" != - || "${CINDERDECK_ALLOW_ADHOC_RELEASE:-0}" == 1 ) ]] || fail "Release requires an exact existing persistent signing identity."
fi
FINAL_APP="$OUTPUT_DIR/$APP_NAME"
[[ ! -e "$FINAL_APP" && ! -L "$FINAL_APP" ]] || fail "Output already exists: $FINAL_APP"

validate_app() {
  local app=$1 expected_id=$2 expected_executable=$3
  [[ "$app" == /* && -d "$app/Contents" && ! -L "$app/Contents" ]] || fail "Expected an absolute app bundle: $app"
  local identifier executable
  identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")
  executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
  [[ "$identifier" == "$expected_id" ]] || fail "Unexpected bundle ID '$identifier' in $app"
  [[ "$executable" == "$expected_executable" && -x "$app/Contents/MacOS/$executable" ]] || fail "Unexpected or missing executable in $app"
}
validate_shell() {
  validate_app "$1" com.ryancardin.cinderdeck.runtime Cinderdeck
  python3 - "$1/Contents/Info.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as file:
    data = plistlib.load(file)
if data.get('CFBundleURLTypes'):
    raise SystemExit('Internal Cinderdeck must not register URL schemes; native Cinderdeck owns them.')
PY
}
# Everything that can change the unsigned runtime: the runtime checkout's
# Git-visible files and ignored .env files, toolchains, build environment, this
# builder, and the commit/dirty state build-desktop-artifact embeds for About.
runtime_cache_key() {
  local top prefix metadata
  top=$(git -C "$RUNTIME_SOURCE" rev-parse --show-toplevel 2>/dev/null) || return 1
  prefix=$(git -C "$RUNTIME_SOURCE" rev-parse --show-prefix) || return 1
  metadata=$(
    printf 'arch=%s\nnode=%s\nrust=%s\nswift=%s\n' "$ARCH" "$("$NODE_BINARY" --version)" \
      "$(rustc --version 2>/dev/null)" "$(xcrun swiftc --version 2>/dev/null | sed -n 1p)"
    printf 'head=%s\n' "$(git -C "$top" rev-parse HEAD 2>/dev/null)"
    [[ -z "$(git -C "$top" status --porcelain --untracked-files=normal)" ]] && echo dirty=0 || echo dirty=1
    env | LC_ALL=C sort | grep -E '^(DECKHAND_|VITE_|EXPO_PUBLIC_|CSC_|APPLE_|APP_VERSION=|NODE_OPTIONS=)' || true
    shasum -a 256 "$ROOT_DIR/scripts/build-unified.sh" "$ROOT_DIR/scripts/runtime-build-env.sh"
  ) || return 1
  python3 - "$top" "$prefix" "$metadata" <<'PY'
import hashlib, os, subprocess, sys
top, prefix, metadata = sys.argv[1:]
digest = hashlib.sha256(metadata.encode())
def ls_files(*args):
    output = subprocess.run(['git', '-C', top, 'ls-files', '-z', *args, '--', prefix or '.'],
                            check=True, capture_output=True).stdout
    return [path for path in output.split(b'\0') if path]
ignored_env = [path for path in ls_files('-o', '-i', '--exclude-standard', '--directory')
               if os.path.basename(path.rstrip(b'/')).startswith(b'.env')]
for path in sorted(set(ls_files('-c', '-o', '--exclude-standard') + ignored_env)):
    full = os.path.join(top.encode(), path)
    if os.path.islink(full):
        digest.update(b'l' + path + b'\0' + os.readlink(full) + b'\0')
    elif os.path.isfile(full):
        with open(full, 'rb') as file:
            content = hashlib.sha256(file.read()).digest()
        digest.update((b'x' if os.access(full, os.X_OK) else b'f') + path + b'\0' + content)
print(digest.hexdigest())
PY
}
# Keep the three most recently used runtime builds.
store_runtime_cache() {
  [[ -n "$RUNTIME_CACHE_KEY" && ! -e "$RUNTIME_CACHE_DIR/$RUNTIME_CACHE_KEY" ]] || return 0
  # Sources edited during the build may not match the key computed before it.
  [[ "$(runtime_cache_key)" == "$RUNTIME_CACHE_KEY" ]] || return 0
  mkdir -p "$RUNTIME_CACHE_DIR"
  local partial
  partial=$(mktemp -d "$RUNTIME_CACHE_DIR/.partial.XXXXXX")
  if ditto "$RUNTIME_APP" "$partial/Cinderdeck.app"; then
    # rename(2) refuses a non-empty destination, so a concurrent writer wins cleanly.
    python3 -c 'import os, sys; os.rename(*sys.argv[1:])' "$partial" "$RUNTIME_CACHE_DIR/$RUNTIME_CACHE_KEY" 2>/dev/null || true
  fi
  rm -rf "$partial"
  local stale
  while IFS= read -r stale; do
    rm -rf "${RUNTIME_CACHE_DIR:?}/$stale"
  done < <(ls -1t "$RUNTIME_CACHE_DIR" | tail -n +4)
}
[[ -z "$RUNTIME_APP" ]] || validate_shell "$RUNTIME_APP"
[[ -z "$NATIVE_APP" ]] || validate_app "$NATIVE_APP" "$BUNDLE_ID" Cinderdeck
for input_app in "$RUNTIME_APP" "$NATIVE_APP"; do
  [[ -n "$input_app" ]] || continue
  input_app="$(cd "$input_app" && pwd -P)"
  case "$OUTPUT_DIR/" in "$input_app/"*) fail "Output must not be inside a prebuilt input app." ;; esac
done


if [[ "$DRY_RUN" == 1 ]]; then
  printf 'Configuration: %s\nArchitecture: %s\nRuntime checkout: %s\n' "$CONFIGURATION" "$ARCH" "$RUNTIME_SOURCE"
  printf 'Runtime app: %s\nNative app: %s\nSigning identity: %s\nOutput: %s\n' \
    "${RUNTIME_APP:-build from runtime source}" "${NATIVE_APP:-build with Xcode}" "$SIGNING_IDENTITY" "$FINAL_APP"
  exit 0
fi

SIGNING_HASH="$SIGNING_IDENTITY"
if [[ "$SIGNING_IDENTITY" != - ]]; then
  IDENTITIES=$(security find-identity -v -p codesigning "$KEYCHAIN")
  SIGNING_HASH=$(printf '%s\n' "$IDENTITIES" | awk -F '"' -v identity="$SIGNING_IDENTITY" '
    { split($1, fields, " "); if ($2 == identity || toupper(fields[2]) == toupper(identity)) print fields[2] }')
  [[ -n "$SIGNING_HASH" && "$SIGNING_HASH" != *$'\n'* && "$SIGNING_HASH" =~ ^[A-Fa-f0-9]{40}$ ]] \
    || fail "Signing identity is unavailable or ambiguous. Use an exact valid certificate name or SHA-1 fingerprint."
fi

if [[ -z "$RUNTIME_APP" ]]; then
  command -v cargo >/dev/null 2>&1 || fail "Rust and Cargo are required to build the runtime helpers. Install Rust (for example: brew install rust), then retry."
  source "$ROOT_DIR/scripts/runtime-build-env.sh"
  ensure_runtime_node
  # Release builds always rebuild the runtime from source.
  if [[ "$RUNTIME_CACHE" != 0 && "$CONFIGURATION" == Debug ]]; then
    RUNTIME_CACHE_KEY=$(runtime_cache_key) || RUNTIME_CACHE_KEY=""
    cached_shell="$RUNTIME_CACHE_DIR/$RUNTIME_CACHE_KEY/Cinderdeck.app"
    if [[ -n "$RUNTIME_CACHE_KEY" && -d "$cached_shell" ]] && (validate_shell "$cached_shell") 2>/dev/null; then
      RUNTIME_APP=$cached_shell
      touch "$RUNTIME_CACHE_DIR/$RUNTIME_CACHE_KEY"
      printf 'Reusing runtime built from identical runtime inputs: %s\n' "$RUNTIME_APP"
    fi
  fi
  [[ -n "$RUNTIME_APP" ]] || install_runtime_dependencies
fi

mkdir -p "$OUTPUT_DIR"
STAGING_DIR=$(mktemp -d "$OUTPUT_DIR/.unified-build.XXXXXX")
cleanup() {
  # Stop the runtime build this script started if the native side failed first.
  if [[ -n "$RUNTIME_PID" ]] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
    kill "$RUNTIME_PID" 2>/dev/null || true
    wait "$RUNTIME_PID" 2>/dev/null || true
  fi
  if [[ "$COMPLETE" == 1 && -n "$STAGING_DIR" ]]; then rm -rf "$STAGING_DIR"; fi
  if [[ "$COMPLETE" == 0 && -n "$STAGING_DIR" ]]; then printf 'Build staging and logs retained: %s\n' "$STAGING_DIR" >&2; fi
}
trap cleanup EXIT

# The runtime and native builds share no inputs, so the runtime builds in the
# background while Xcode compiles. exec makes RUNTIME_PID the builder itself.
if [[ -z "$RUNTIME_APP" ]]; then
  RUNTIME_OUTPUT="$STAGING_DIR/runtime"
  printf 'Building Cinderdeck runtime. Log: %s\n' "$STAGING_DIR/runtime-build.log"
  (cd "$RUNTIME_SOURCE" && \
    export PATH="$(dirname "$NODE_BINARY"):$RUNTIME_SOURCE/node_modules/.bin:$PATH" \
      CINDERDECK_NATIVE_SHELL_BUILD=1 DECKHAND_DESKTOP_SIGNED=false && \
    exec "$NODE_BINARY" scripts/build-desktop-artifact.ts --platform mac --target dir --arch "$ARCH" --output-dir "$RUNTIME_OUTPUT") \
    > "$STAGING_DIR/runtime-build.log" 2>&1 &
  RUNTIME_PID=$!
fi

if [[ -z "$NATIVE_APP" ]]; then
  case "$ARCH" in arm64) NATIVE_ARCHS=arm64 ;; x64) NATIVE_ARCHS=x86_64 ;; universal) NATIVE_ARCHS='arm64 x86_64' ;; esac
  printf 'Building native Cinderdeck. Log: %s\n' "$STAGING_DIR/native-build.log"
  if ! xcodebuild -project "$ROOT_DIR/Cinderdeck.xcodeproj" -scheme Cinderdeck \
    -configuration "$CONFIGURATION" -destination 'platform=macOS' -derivedDataPath "$NATIVE_DERIVED_DATA" \
    "ARCHS=$NATIVE_ARCHS" ONLY_ACTIVE_ARCH=NO COMPILER_INDEX_STORE_ENABLE=NO \
    CODE_SIGN_IDENTITY= CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    'OTHER_SWIFT_FLAGS=$(inherited) -Xllvm -sil-disable-pass=PerfInliner' \
    build > "$STAGING_DIR/native-build.log" 2>&1; then
    tail -60 "$STAGING_DIR/native-build.log" >&2
    fail "Native build failed."
  fi
  NATIVE_APP="$NATIVE_DERIVED_DATA/Build/Products/$CONFIGURATION/$APP_NAME"
  validate_app "$NATIVE_APP" "$BUNDLE_ID" Cinderdeck
fi

if [[ -n "$RUNTIME_PID" ]]; then
  printf 'Waiting for Cinderdeck runtime.\n'
  if ! wait "$RUNTIME_PID"; then
    RUNTIME_PID=""
    tail -60 "$STAGING_DIR/runtime-build.log" >&2
    fail "Internal runtime build failed."
  fi
  RUNTIME_PID=""
  while IFS= read -r -d '' app; do
    [[ -z "$RUNTIME_APP" ]] || fail "Runtime builder produced multiple Cinderdeck apps."
    RUNTIME_APP=$app
  done < <(find "$RUNTIME_OUTPUT" -type d -name Cinderdeck.app -prune -print0)
  [[ -n "$RUNTIME_APP" ]] || fail "Runtime builder did not produce Cinderdeck.app."
  validate_shell "$RUNTIME_APP"
  store_runtime_cache
fi

# Check the selected/prebuilt products agree with the requested architecture.
for app_binary in "$NATIVE_APP/Contents/MacOS/Cinderdeck" "$RUNTIME_APP/Contents/MacOS/Cinderdeck"; do
  binary_archs=$(lipo -archs "$app_binary")
  case "$ARCH" in
    arm64) [[ " $binary_archs " == *' arm64 '* ]] || fail "Missing arm64 in $app_binary" ;;
    x64) [[ " $binary_archs " == *' x86_64 '* ]] || fail "Missing x86_64 in $app_binary" ;;
    universal) [[ " $binary_archs " == *' arm64 '* && " $binary_archs " == *' x86_64 '* ]] || fail "Expected a universal product: $app_binary" ;;
  esac
done

STAGED_APP="$STAGING_DIR/$APP_NAME"
ditto "$NATIVE_APP" "$STAGED_APP"
[[ -d "$STAGED_APP/Contents/Resources" && ! -L "$STAGED_APP/Contents/Resources" ]] || fail "Native Resources must be a real directory."
SHELL_DEST="$STAGED_APP/Contents/Resources/Cinderdeck.app"
rm -rf "$SHELL_DEST"
ditto "$RUNTIME_APP" "$SHELL_DEST"
# The executable stays an internal implementation detail; macOS presents its
# running window using the child bundle's name and icon, not the outer app's.
python3 - "$STAGED_APP" "$SHELL_DEST" <<'PY'
import pathlib, plistlib, shutil, sys
native, shell = (pathlib.Path(path) / 'Contents' for path in sys.argv[1:])
with (native / 'Info.plist').open('rb') as file:
    native_info = plistlib.load(file)
with (shell / 'Info.plist').open('rb') as file:
    shell_info = plistlib.load(file)
icon_name = native_info.get('CFBundleIconFile', 'AppIcon')
if pathlib.Path(icon_name).name != icon_name:
    raise SystemExit('Native app icon must be a resource filename.')
icon_file = icon_name if icon_name.endswith('.icns') else icon_name + '.icns'
source = native / 'Resources' / icon_file
if not source.is_file():
    raise SystemExit('Native Cinderdeck app icon is missing.')
(shell / 'Resources').mkdir(exist_ok=True)
shutil.copy2(source, shell / 'Resources' / icon_file)
# Electron resolves its helper bundles from CFBundleName. Keep the internal
# Cinderdeck name aligned with their executables.
shell_info.update(CFBundleName='Cinderdeck', CFBundleDisplayName='Cinderdeck',
                  CFBundleIconFile=icon_file, LSUIElement=True)
# The outer app owns the single Dock icon, including when reusing native builds.
native_info['LSUIElement'] = False
with (native / 'Info.plist').open('wb') as file:
    plistlib.dump(native_info, file)
# Use the copied ICNS rather than the runtime's compiled icon catalog.
shell_info.pop('CFBundleIconName', None)
with (shell / 'Info.plist').open('wb') as file:
    plistlib.dump(shell_info, file)
PY
validate_app "$STAGED_APP" "$BUNDLE_ID" Cinderdeck
validate_shell "$SHELL_DEST"
[[ -d "$STAGED_APP/Contents/Frameworks/Sparkle.framework" ]] || fail "Native Sparkle.framework is missing."

APPLE_SIGNING=unknown
sign() {
  local args=(--force --sign "$SIGNING_HASH" --options runtime "${CINDERDECK_SIGNING_TIMESTAMP:---timestamp=none}")
  [[ "$SIGNING_HASH" == - ]] || args+=(--keychain "$KEYCHAIN")
  codesign "${args[@]}" "$@"
  if [[ "$APPLE_SIGNING" == unknown ]]; then
    local argument target=""
    for argument in "$@"; do target=$argument; done
    if codesign --verify --strict -R='anchor apple generic' "$target" >/dev/null 2>&1; then
      APPLE_SIGNING=apple
    else
      APPLE_SIGNING=local
    fi
  fi
}
sign_item() {
  local item=$1 electron_app=${2:-0} entitlements
  entitlements=$(mktemp "$STAGING_DIR/entitlements.XXXXXX")
  # Keep the entitlements already assigned to helpers/frameworks/native modules.
  codesign --display --entitlements :- "$item" > "$entitlements" 2>/dev/null || true
  if [[ "$electron_app" == 1 ]]; then
    python3 - "$entitlements" "$APPLE_SIGNING" <<'PY'
import plistlib, sys
path = sys.argv[1]
try:
    with open(path, 'rb') as file: data = plistlib.load(file)
except (OSError, ValueError, plistlib.InvalidFileException):
    data = {}
# V8's executable memory remains permitted when the outer packager applies hardened runtime.
data['com.apple.security.cs.allow-jit'] = True
data['com.apple.security.cs.allow-unsigned-executable-memory'] = True
if sys.argv[2] != 'apple':
    data['com.apple.security.cs.disable-library-validation'] = True
with open(path, 'wb') as file: plistlib.dump(data, file)
PY
  fi
  if [[ -s "$entitlements" ]]; then
    plutil -lint "$entitlements" >/dev/null || fail "Could not preserve entitlements for $item"
    sign --entitlements "$entitlements" "$item"
  else
    sign "$item"
  fi
}
sign_tree() {
  local tree=$1 skip=${2:-} electron_tree=${3:-0} item description
  # -depth visits children before enclosing bundles. Never follow framework symlinks.
  while IFS= read -r -d '' item; do
    [[ "$item" != "$STAGED_APP" ]] || continue
    if [[ -n "$skip" ]]; then case "$item" in "$skip"|"$skip"/*) continue ;; esac; fi
    if [[ -f "$item" && ! -L "$item" ]]; then
      description=$(file -b "$item")
      [[ "$description" != *Mach-O* ]] || sign_item "$item"
    elif [[ -d "$item" && ! -L "$item" ]]; then
      case "$item" in
        *.app) sign_item "$item" "$electron_tree" ;;
        *.framework|*.xpc) sign_item "$item" ;;
        *.bundle)
          # SwiftPM resource-only bundles are sealed by their enclosing app.
          if /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$item/Contents/Info.plist" >/dev/null 2>&1 || \
            /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$item/Info.plist" >/dev/null 2>&1; then
            sign_item "$item"
          fi
          ;;
      esac
    fi
  done < <(find "$tree" -depth -print0)
}
printf 'Signing internal runtime, native helpers, then outer application.\n'
sign_tree "$SHELL_DEST" "" 1
sign_tree "$STAGED_APP" "$SHELL_DEST"

# The source contains Xcode variables; resolve them for this actual native bundle ID.
NATIVE_ENTITLEMENTS="$STAGING_DIR/native-entitlements.plist"
EXISTING_NATIVE_ENTITLEMENTS="$STAGING_DIR/existing-native-entitlements.plist"
codesign --display --entitlements :- "$STAGED_APP" > "$EXISTING_NATIVE_ENTITLEMENTS" 2>/dev/null || true
python3 - "$ROOT_DIR/Cinderdeck/Cinderdeck.entitlements" "$EXISTING_NATIVE_ENTITLEMENTS" "$NATIVE_ENTITLEMENTS" "$BUNDLE_ID" <<'PY'
import plistlib, sys
source, old, destination, bundle_id = sys.argv[1:]
try:
    with open(old, 'rb') as file: data = plistlib.load(file)
except (OSError, ValueError, plistlib.InvalidFileException):
    data = {}
with open(source, 'rb') as file:
    declared = plistlib.loads(file.read().replace(b'$(PRODUCT_BUNDLE_IDENTIFIER)', bundle_id.encode()))
data.update(declared)
with open(destination, 'wb') as file: plistlib.dump(data, file)
PY
# Self-signed/ad-hoc builds have no Apple Team ID: preserve local Sparkle loading.
if ! codesign --verify --strict -R='anchor apple generic' "$STAGED_APP/Contents/Frameworks/Sparkle.framework" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c 'Delete :com.apple.security.cs.disable-library-validation' "$NATIVE_ENTITLEMENTS" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.disable-library-validation bool true' "$NATIVE_ENTITLEMENTS"
fi
sign --entitlements "$NATIVE_ENTITLEMENTS" "$STAGED_APP"
codesign --verify --deep --strict "$SHELL_DEST"
codesign --verify --deep --strict "$STAGED_APP"
if [[ "$CONFIGURATION" == Release && "$SIGNING_HASH" != - ]]; then
  requirement=$(codesign -dr - "$STAGED_APP" 2>&1 | sed -n 's/^designated => //p')
  [[ -n "$requirement" && "$requirement" != *cdhash* && ( "$requirement" == *certificate* || "$requirement" == *anchor* ) ]] \
    || fail "Release must retain a certificate-based designated requirement."
fi
[[ ! -e "$FINAL_APP" && ! -L "$FINAL_APP" ]] || fail "Output appeared during the build; refusing to replace it."
mv -n "$STAGED_APP" "$FINAL_APP"
[[ ! -e "$STAGED_APP" ]] || fail "Output already exists; staged app was not moved."
COMPLETE=1
printf 'Unified app ready for manual validation: %s\n' "$FINAL_APP"
printf 'Native identity: %s; the runtime is bundled with Cinderdeck.\n' "$BUNDLE_ID"
