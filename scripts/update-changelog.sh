#!/bin/bash
# update-changelog.sh - Adds a versioned entry to CHANGELOG.md: the "## Unreleased" section
# when it has entries, otherwise the generated content file.
# Usage: ./scripts/update-changelog.sh <version> <changelog_content_file>
#
# Example:
#   ./scripts/update-changelog.sh "1.2.3" "build/changelog.md"

set -euo pipefail

VERSION="${1:?Usage: update-changelog.sh <version> <changelog_content_file>}"
CONTENT_FILE="${2:?Usage: update-changelog.sh <version> <changelog_content_file>}"
CHANGELOG_FILE="${3:-CHANGELOG.md}"

if [ ! -f "$CONTENT_FILE" ]; then
  echo "::error::Changelog content file not found: $CONTENT_FILE"
  exit 1
fi

if [ ! -f "$CHANGELOG_FILE" ]; then
  echo "::error::CHANGELOG.md not found: $CHANGELOG_FILE"
  exit 1
fi

CONTENT=$(cat "$CONTENT_FILE")
DATE=$(date +%Y-%m-%d)

# A hand-written "## Unreleased" section with entries becomes this release's notes;
# the generated content is used only when there is none.
has_unreleased_notes() {
  awk '
    /^## Unreleased[[:space:]]*$/ { inside = 1; next }
    inside && /^## / { exit }
    inside && NF { found = 1; exit }
    END { exit !found }
  ' "$CHANGELOG_FILE"
}

if ! has_unreleased_notes && [ -z "$CONTENT" ]; then
  echo "::warning::Changelog content is empty, skipping update"
  exit 0
fi

# Build the new entry
NEW_ENTRY="## [${VERSION}] - ${DATE}

${CONTENT}"

# Print lines without trailing blank lines (used for the file header).
print_without_trailing_blanks() {
  awk '
    { lines[NR] = $0 }
    END {
      end = NR
      while (end > 0 && lines[end] == "") end--
      for (i = 1; i <= end; i++) print lines[i]
    }
  '
}

# Find the first version entry (Keep a Changelog "## [x.y.z]" heading).
HEADER_END=$(awk '/^## \[/ { print NR; exit }' "$CHANGELOG_FILE")

if has_unreleased_notes; then
  awk -v heading="## [${VERSION}] - ${DATE}" '
    !done && /^## Unreleased[[:space:]]*$/ { print heading; done = 1; next }
    { print }
  ' "$CHANGELOG_FILE" > "${CHANGELOG_FILE}.tmp"
else {
  if [ -n "$HEADER_END" ]; then
    # Keep the preamble only; drop any blank lines that accumulated before
    # the first version heading, then insert the new entry.
    head -n $((HEADER_END - 1)) "$CHANGELOG_FILE" | print_without_trailing_blanks
  else
    # No existing entries — keep the whole file, minus trailing blanks.
    print_without_trailing_blanks < "$CHANGELOG_FILE"
  fi

  echo ""
  printf '%s\n' "$NEW_ENTRY"

  if [ -n "$HEADER_END" ]; then
    echo ""
    tail -n +$((HEADER_END)) "$CHANGELOG_FILE"
  fi
} > "${CHANGELOG_FILE}.tmp"
fi

# When publishing a stable version, remove the prerelease entries of the same
# base version (e.g. [1.2.3-beta.1] when releasing [1.2.3]): their commits are
# already folded into the stable entry above, so listing them individually is
# noise. Beta entries of other (abandoned) base versions are left untouched.
BASE_VERSION="${VERSION%%-*}"
if [ "$BASE_VERSION" = "$VERSION" ]; then
  awk -v base="$BASE_VERSION" '
    substr($0, 1, 4) == "## [" { skip = (index($0, "## [" base "-") == 1) }
    !skip { print }
  ' "${CHANGELOG_FILE}.tmp" | print_without_trailing_blanks > "${CHANGELOG_FILE}.tmp2"
  mv "${CHANGELOG_FILE}.tmp2" "${CHANGELOG_FILE}.tmp"
fi

mv "${CHANGELOG_FILE}.tmp" "$CHANGELOG_FILE"

echo "Updated $CHANGELOG_FILE with v${VERSION} entry"
