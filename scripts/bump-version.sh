#!/bin/bash
# bump-version.sh - Bumps MARKETING_VERSION in project.pbxproj
# Usage: ./scripts/bump-version.sh [patch|minor|major] [stable|beta]
#
# Channel semantics:
#   stable + current stable -> normal bump (per bump type)
#   stable + current beta   -> promotion: strip -beta suffix, keep base (bump type ignored)
#   beta   + current stable -> bump base per type, then -beta.N (N from existing git tags)
#   beta   + current beta   -> keep base, next -beta.N (N from existing git tags)
# Build number always increments by 1 (global monotonic counter across channels).

set -euo pipefail

PBXPROJ="Cinderdeck.xcodeproj/project.pbxproj"
BUMP_TYPE="${1:-patch}"
CHANNEL="${2:-stable}"

case "$BUMP_TYPE" in
  major | minor | patch) ;;
  *)
    echo "::error::Invalid bump type: $BUMP_TYPE (use patch, minor, or major)"
    exit 1
    ;;
esac

case "$CHANNEL" in
  stable | beta) ;;
  *)
    echo "::error::Invalid channel: $CHANNEL (use stable or beta)"
    exit 1
    ;;
esac

# Extract current MARKETING_VERSION (may carry a -beta.N suffix)
CURRENT_VERSION=$(grep -m1 'MARKETING_VERSION' "$PBXPROJ" | sed 's/.*= //' | sed 's/;.*//' | tr -d ' ')

if [ -z "$CURRENT_VERSION" ]; then
  echo "::error::Could not find MARKETING_VERSION in $PBXPROJ"
  exit 1
fi

BASE_VERSION="${CURRENT_VERSION%%-*}"
CURRENT_IS_PRERELEASE=0
[ "$BASE_VERSION" != "$CURRENT_VERSION" ] && CURRENT_IS_PRERELEASE=1

# Parse semver base only, never the full pre-release string
# (handle 2-part versions like "1.0" -> "1.0.0")
IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"
MAJOR="${MAJOR:-0}"
MINOR="${MINOR:-0}"
PATCH="${PATCH:-0}"

bump_base() {
  case "$BUMP_TYPE" in
    major)
      MAJOR=$((MAJOR + 1))
      MINOR=0
      PATCH=0
      ;;
    minor)
      MINOR=$((MINOR + 1))
      PATCH=0
      ;;
    patch)
      PATCH=$((PATCH + 1))
      ;;
  esac
}

# Next beta number for a base version, derived from existing tags (requires full git history)
next_beta_number() {
  local base="$1"
  local last_n
  # Guard against shallow checkouts: an empty tag list would silently reset to
  # beta.1 and collide with an existing tag at publish time
  if [ -z "$(git tag -l 'v*' | head -1)" ]; then
    echo "::error::No v* tags visible — cannot compute beta number safely (shallow checkout? run 'git fetch --tags')" >&2
    exit 1
  fi
  last_n=$(git tag -l "v${base}-beta.*" | sed -E 's/^v.*-beta\.([0-9]+)$/\1/' | sort -n | tail -1)
  echo $((${last_n:-0} + 1))
}

if [ "$CHANNEL" = "stable" ]; then
  if [ "$CURRENT_IS_PRERELEASE" = "1" ]; then
    NEW_VERSION="$BASE_VERSION"
  else
    bump_base
    NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
  fi
else
  if [ "$CURRENT_IS_PRERELEASE" = "1" ]; then
    NEW_BASE="$BASE_VERSION"
  else
    bump_base
    NEW_BASE="${MAJOR}.${MINOR}.${PATCH}"
  fi
  NEW_VERSION="${NEW_BASE}-beta.$(next_beta_number "$NEW_BASE")"
fi

# Replace all occurrences of MARKETING_VERSION in pbxproj (anchor on trailing ';')
sed "s/MARKETING_VERSION = ${CURRENT_VERSION};/MARKETING_VERSION = ${NEW_VERSION};/g" "$PBXPROJ" > "${PBXPROJ}.tmp" && mv "${PBXPROJ}.tmp" "$PBXPROJ"

# Bump build number (increment by 1)
CURRENT_BUILD=$(grep -m1 'CURRENT_PROJECT_VERSION' "$PBXPROJ" | sed 's/.*= //' | sed 's/;.*//' | tr -d ' ')
NEW_BUILD=$((CURRENT_BUILD + 1))
sed "s/CURRENT_PROJECT_VERSION = ${CURRENT_BUILD};/CURRENT_PROJECT_VERSION = ${NEW_BUILD};/g" "$PBXPROJ" > "${PBXPROJ}.tmp" && mv "${PBXPROJ}.tmp" "$PBXPROJ"

echo "version=${NEW_VERSION}"
echo "previous_version=${CURRENT_VERSION}"
echo "build_number=${NEW_BUILD}"
echo "channel=${CHANNEL}"
