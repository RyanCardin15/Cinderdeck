#!/usr/bin/env bash
# Sourced by the whole-app builder. Tool downloads stay inside this clone.
ensure_runtime_node() {
  local candidate="${CINDERDECK_NODE_BINARY:-$(command -v node || true)}"
  if [[ -n "$candidate" && -x "$candidate" ]] && "$candidate" -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a===24 && (b>13 || (b===13 && c>=1)) ? 0 : 1)' 2>/dev/null; then
    NODE_BINARY="$candidate"
    return
  fi
  [[ -z "${CINDERDECK_NODE_BINARY:-}" ]] || fail "CINDERDECK_NODE_BINARY must point to Node 24.13.1+ within Node 24."
  local node_arch archive tools_dir download checksum
  case "$(uname -m)" in arm64) node_arch=arm64 ;; x86_64) node_arch=x64 ;; *) fail "Unsupported build host." ;; esac
  tools_dir="$ROOT_DIR/.build/toolchains"
  archive="node-v24.13.1-darwin-$node_arch.tar.gz"
  NODE_BINARY="$tools_dir/node-v24.13.1-darwin-$node_arch/bin/node"
  if [[ ! -x "$NODE_BINARY" ]]; then
    mkdir -p "$tools_dir"
    download=$(mktemp -d "$tools_dir/.node-download.XXXXXX")
    printf 'Downloading Node 24.13.1 into this checkout.\n'
    if ! curl --fail --location --retry 3 "https://nodejs.org/dist/v24.13.1/$archive" -o "$download/$archive" \
      || ! curl --fail --location --retry 3 'https://nodejs.org/dist/v24.13.1/SHASUMS256.txt' -o "$download/SHASUMS256.txt"; then
      fail "Node download failed; retry or set CINDERDECK_NODE_BINARY. Download retained: $download"
    fi
    checksum=$(awk -v name="$archive" '$2 == name {print $1}' "$download/SHASUMS256.txt")
    [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || fail "Node archive checksum missing."
    [[ "$(shasum -a 256 "$download/$archive" | awk '{print $1}')" == "$checksum" ]] || fail "Node archive checksum mismatch."
    tar -xzf "$download/$archive" -C "$tools_dir"
    rm -rf "$download"
  fi
}
install_runtime_dependencies() {
  local pnpm_version npm_binary
  pnpm_version=$("$NODE_BINARY" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).packageManager.split("@")[1]' "$RUNTIME_SOURCE/package.json")
  npm_binary="$(dirname "$NODE_BINARY")/npm"
  printf 'Installing locked agent runtime dependencies (pnpm %s).\n' "$pnpm_version"
  # Pin the package manager too; never depend on another checkout's node_modules.
  if [[ -x "$npm_binary" ]]; then
    (cd "$RUNTIME_SOURCE" && VP_GIT_HOOKS=0 PATH="$(dirname "$NODE_BINARY"):$PATH" "$npm_binary" exec --yes --package="pnpm@$pnpm_version" -- pnpm install --frozen-lockfile)
  elif command -v pnpm >/dev/null 2>&1 && [[ "$(PATH="$(dirname "$NODE_BINARY"):$PATH" pnpm --version)" == "$pnpm_version" ]]; then
    (cd "$RUNTIME_SOURCE" && VP_GIT_HOOKS=0 PATH="$(dirname "$NODE_BINARY"):$PATH" pnpm install --frozen-lockfile)
  else
    fail "Node installation lacks npm. Use a full Node 24 installation or install pnpm@$pnpm_version."
  fi
}
