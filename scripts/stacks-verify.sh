#!/bin/bash
# Builds and verifies the Stacks feature: Debug build, Stacks unit tests, and an
# end-to-end run of the CLI/MCP against a throwaway fixture stack.
#
#   scripts/stacks-verify.sh [build|test|e2e|all]   run once (default: all)
#   scripts/stacks-verify.sh --watch                run whenever .build/agent-verify/request appears
#
# Watch mode lets an assistant request a fixed action (build/test/e2e/all) by
# writing that word to the request file; results land in .build/agent-verify/.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.build/agent-verify"
DERIVED="$OUT/derived"
FIX="$OUT/fixture"
APP="$DERIVED/Build/Products/Debug/Snapzy Debug.app"
BIN="$APP/Contents/MacOS/Snapzy"
mkdir -p "$OUT"
cd "$ROOT"

COMMON=(-project Snapzy.xcodeproj -scheme Snapzy -configuration Debug -destination 'platform=macOS,arch=arm64'
  -derivedDataPath "$DERIVED" CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=)

do_build() {
  echo "[build] $(date +%T)"
  xcodebuild build "${COMMON[@]}" > "$OUT/build.log" 2>&1
  local status=$?
  echo "$status" > "$OUT/build.status"
  grep -E "(error|warning): " "$OUT/build.log" | grep -E "/Stack|/Snapzy(Main|App)|/AppCoordinator|/HistoryFloating|error:" | sort -u > "$OUT/build.issues" || true
  echo "[build] status $status"
  return $status
}

do_test() {
  echo "[test] $(date +%T)"
  xcodebuild test "${COMMON[@]}" -parallel-testing-enabled NO \
    -only-testing:SnapzyTests/StackDefinitionLoaderTests -only-testing:SnapzyTests/GitStatusParserTests \
    -only-testing:SnapzyTests/GitRecentBranchesTests -only-testing:SnapzyTests/AnsiParserTests -only-testing:SnapzyTests/LogBufferTests \
    -only-testing:SnapzyTests/StackProcessIntegrationTests -only-testing:SnapzyTests/StackSupervisorOrderingTests \
    -only-testing:SnapzyTests/GitServiceIntegrationTests -only-testing:SnapzyTests/StackRunStoreTests \
    -only-testing:SnapzyTests/StackConfigurationTests -only-testing:SnapzyTests/StackDefinitionWatcherTests \
    -only-testing:SnapzyTests/StackKeyboardTests -only-testing:SnapzyTests/StackCrashRecoveryTests \
    -only-testing:SnapzyTests/StackEnvironmentAndSecretsTests -only-testing:SnapzyTests/StackControlTests \
    -only-testing:SnapzyTests/DatabaseManagerTests -only-testing:SnapzyTests/ClipboardTextHistoryStoreTests \
    -only-testing:SnapzyTests/SimpleTOMLParserTests > "$OUT/test.log" 2>&1
  local status=$?
  echo "$status" > "$OUT/test.status"
  grep -E "error:|failed|Test Suite .* (passed|failed)|Executed [0-9]+ tests" "$OUT/test.log" | tail -60 > "$OUT/test.summary" || true
  echo "[test] status $status"
  return $status
}

make_fixture() {
  pkill -f "SNAPZY_STACKS_PREVIEW_ROOT_MARKER" 2>/dev/null
  pkill -f "$BIN" 2>/dev/null; sleep 1
  for port in 47811 47812 47813; do lsof -tiTCP:$port -sTCP:LISTEN | xargs kill 2>/dev/null; done
  rm -rf "$FIX"; mkdir -p "$FIX/stacks" "$FIX/projects/web" "$FIX/projects/api"
  (cd "$FIX/projects/web" && git init -q -b main && echo "hello" > index.html && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git branch feature/demo)
  cat > "$FIX/stacks/demo.toml" <<TOML
name = "Demo Stack"
root = "$FIX/projects"

[repos.web]
path = "web"

[services.api]
cwd = "api"
cmd = "echo 'api starting'; exec python3 -m http.server 47811 --bind 127.0.0.1"
port = 47811
ready.port = 47811

[services.web]
repo = "web"
cmd = "echo 'web booting'; sleep 1; echo 'READY on 47812'; exec python3 -m http.server 47812 --bind 127.0.0.1"
depends_on = ["api"]
port = 47812
ready.log = "READY"

[services.worker]
cmd = "while true; do echo \"tick \$(date +%T)\"; sleep 2; done"
TOML
}

do_e2e() {
  echo "[e2e] $(date +%T)"
  [ -x "$BIN" ] || { echo "no app build"; echo 1 > "$OUT/e2e.status"; return 1; }
  make_fixture
  export SNAPZY_STACKS_PREVIEW_ROOT="$FIX"
  local log="$OUT/e2e.log"; : > "$log"
  run() { echo; echo "\$ snapzy $*" >> "$log"; "$BIN" "$@" >> "$log" 2>&1; echo "[exit $?]" >> "$log"; }
  "$BIN" -AppleLanguages "(en)" > "$OUT/app.log" 2>&1 &
  echo "app pid $!" >> "$log"
  for i in $(seq 1 60); do [ -S "$FIX/Agent/control.sock" ] && break; sleep 0.5; done
  run stacks ping
  run stacks status
  run stacks start demo --as Codex --session e2e
  run stacks status demo --json
  run stacks logs demo -n 20
  (cd "$FIX/projects/api" && exec python3 -m http.server 47813 --bind 127.0.0.1 > /dev/null 2>&1) &
  local stray=$!
  sleep 1.5
  run stacks ports --external
  run stacks ports 47811
  run stacks claim demo "running e2e tests" --as Codex --session e2e --ttl 10
  run stacks restart demo worker --as Cursor
  run stacks restart demo worker --as Codex --session e2e
  run stacks switch demo feature/demo --as Codex --session e2e
  run stacks git demo
  run stacks events demo
  run stacks validate "$FIX/stacks/demo.toml"
  run stacks kill-port 47813 $stray --as Codex --session e2e
  echo >> "$log"; echo '$ snapzy mcp  (initialize, tools/list, list_stacks, read_logs, list_ports)' >> "$log"
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"cursor-vscode","version":"1"},"capabilities":{}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_stacks","arguments":{}}}' \
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_logs","arguments":{"stack":"demo","service":"worker","lines":3}}}' \
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"start_stack","arguments":{"stack":"demo"}}}' \
    | "$BIN" mcp >> "$log" 2>&1
  echo "[exit $?]" >> "$log"
  cp "$FIX/Agent/state.json" "$OUT/state.json" 2>/dev/null
  run stacks release demo --as Codex --session e2e
  run stacks status
  echo 0 > "$OUT/e2e.status"
  echo "[e2e] done — app left running for inspection (pkill -f '$BIN' to quit)"
}

run_action() {
  case "$1" in
    build) do_build ;;
    test) do_test ;;
    e2e) do_build && do_e2e ;;
    all) do_build && do_test; do_e2e ;;
    *) echo "unknown action $1" ;;
  esac
  date +%s > "$OUT/done"
}

if [ "${1:-}" = "--watch" ]; then
  echo "Watching $OUT/request (Ctrl-C to stop)…"
  while true; do
    date +%s > "$OUT/watching"
    if [ -f "$OUT/request" ]; then
      action="$(tr -d '[:space:]' < "$OUT/request")"; rm -f "$OUT/request" "$OUT/done"
      case "$action" in build|test|e2e|all) run_action "$action" ;; *) echo "ignored request '$action'" ;; esac
    fi
    sleep 2
  done
else
  run_action "${1:-all}"
fi
