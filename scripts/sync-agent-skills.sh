#!/bin/bash
# Copy the agent skills in skills/ to the folders coding agents read in a clone:
#   .claude/skills/  Claude Code
#   .agents/skills/  Codex, Cursor, and other Agent Skills clients
#
# Usage:
#   scripts/sync-agent-skills.sh           # update the copies after editing skills/
#   scripts/sync-agent-skills.sh --check   # exit 1 if a copy differs from skills/

set -euo pipefail

cd "$(dirname "$0")/.."
SOURCE="skills"
TARGETS=(".claude/skills" ".agents/skills")

status=0
for skill in "$SOURCE"/*/; do
  name="$(basename "$skill")"
  for target in "${TARGETS[@]}"; do
    if [[ "${1:-}" == "--check" ]]; then
      if ! diff -r "$SOURCE/$name" "$target/$name" >/dev/null 2>&1; then
        echo "error: $target/$name is out of date. Run scripts/sync-agent-skills.sh" >&2
        status=1
      fi
    else
      mkdir -p "$target"
      rm -rf "${target:?}/$name"
      cp -R "$SOURCE/$name" "$target/$name"
      echo "Synced $target/$name"
    fi
  done
done
exit $status
