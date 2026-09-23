#!/bin/bash
# update-appcast.sh - Prepends a new <item> to appcast.xml for Sparkle updates
# Usage: ./scripts/update-appcast.sh <version> <build_number> <dmg_path> [appcast_file] [ed_signature] [release_notes_html] [channel]
#
# Example:
#   ./scripts/update-appcast.sh "1.2.3" "42" "build/Cinderdeck-v1.2.3.dmg" "appcast.xml" "abc123..." "<h3>Features</h3><ul><li>New feature</li></ul>" "beta"
#
# The release_notes_html argument should contain the inner HTML for the release notes
# (everything inside the <body> tag). A default style block is automatically prepended.
# channel: optional Sparkle channel name (e.g. "beta"). Empty = default (stable) channel.

set -euo pipefail

VERSION="${1:?Usage: update-appcast.sh <version> <build_number> <dmg_path> [appcast_file] [ed_signature] [release_notes_html] [channel]}"
BUILD_NUMBER="${2:?Usage: update-appcast.sh <version> <build_number> <dmg_path> [appcast_file] [ed_signature] [release_notes_html] [channel]}"
DMG_PATH="${3:?Usage: update-appcast.sh <version> <build_number> <dmg_path> [appcast_file] [ed_signature] [release_notes_html] [channel]}"
APPCAST_FILE="${4:-appcast.xml}"
ED_SIGNATURE="${5:-}"
RELEASE_NOTES_HTML="${6:-}"
CHANNEL="${7:-}"

if [ ! -f "$DMG_PATH" ]; then
  echo "::error::DMG file not found: $DMG_PATH"
  exit 1
fi

if [ ! -f "$APPCAST_FILE" ]; then
  echo "::error::Appcast file not found: $APPCAST_FILE"
  exit 1
fi

# Detect minimum macOS system version
get_minimum_macos_version() {
  local app_plist="build/Cinderdeck.app/Contents/Info.plist"
  local proj_file="Cinderdeck.xcodeproj/project.pbxproj"
  local resolved_version=""
  local source=""

  # 1. Try to read from compiled app bundle Info.plist (macOS only via plutil)
  if [ -f "$app_plist" ] && command -v plutil >/dev/null 2>&1; then
    resolved_version=$(plutil -extract LSMinimumSystemVersion raw -o - "$app_plist" 2>/dev/null || echo "")
    source="build/Cinderdeck.app/Contents/Info.plist"
  fi

  # 2. Try to read from compiled app bundle Info.plist (macOS only via PlistBuddy)
  if [ -z "$resolved_version" ] && [ -f "$app_plist" ] && [ -f "/usr/libexec/PlistBuddy" ]; then
    resolved_version=$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "$app_plist" 2>/dev/null || echo "")
    source="build/Cinderdeck.app/Contents/Info.plist (PlistBuddy)"
  fi

  # 3. Fallback: Parse MACOSX_DEPLOYMENT_TARGET from pbxproj file
  if [ -z "$resolved_version" ] && [ -f "$proj_file" ]; then
    resolved_version=$(grep -m 1 "MACOSX_DEPLOYMENT_TARGET =" "$proj_file" | cut -d'=' -f2 | tr -d ' ;"\t\r' 2>/dev/null || echo "")
    source="Cinderdeck.xcodeproj/project.pbxproj"
  fi

  # 4. Final Fallback: hardcoded default
  if [ -z "$resolved_version" ]; then
    resolved_version="13.0"
    source="Default Fallback"
  fi

  # Validation: must be semantic format (digits and dots only)
  if [[ ! "$resolved_version" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
    echo "::warning::Detected invalid macOS version string: '$resolved_version' from $source. Using default '13.0'." >&2
    resolved_version="13.0"
    source="Default (Validation Failed)"
  fi

  echo "Detected minimum macOS version: $resolved_version (Source: $source)" >&2
  echo "$resolved_version"
}

MIN_MACOS_VERSION=$(get_minimum_macos_version)

# Get file size in bytes
if [[ "$OSTYPE" == "darwin"* ]]; then
  FILE_SIZE=$(stat -f%z "$DMG_PATH")
else
  FILE_SIZE=$(stat -c%s "$DMG_PATH")
fi

# Generate RFC 2822 date
PUB_DATE=$(date -u '+%a, %d %b %Y %H:%M:%S +0000')

# Download URL
DOWNLOAD_URL="https://github.com/RyanCardin15/Cinderdeck/releases/download/v${VERSION}/Cinderdeck-v${VERSION}.dmg"

# Default release notes if none provided
if [ -z "$RELEASE_NOTES_HTML" ]; then
  RELEASE_NOTES_HTML="<h3>🔧 Maintenance</h3><ul><li>Bug fixes and improvements</li></ul>"
fi

# Common style block for release notes
STYLE_BLOCK='<style>:root { color-scheme: light dark; } body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; padding: 8px 16px; } h3 { font-size: 14px; margin: 12px 0 6px; } ul { padding-left: 20px; margin: 4px 0; } li { margin: 3px 0; }</style>'

# Build the new <item> block into a temp file
ITEM_FILE="${APPCAST_FILE}.item.tmp"
trap 'rm -f "$ITEM_FILE" "${ITEM_FILE}.awk" "${APPCAST_FILE}.tmp"' EXIT
cat > "$ITEM_FILE" << EOF
    <item>
      <title>Version ${VERSION}</title>
      <sparkle:version>${BUILD_NUMBER}</sparkle:version>
      <sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${MIN_MACOS_VERSION}</sparkle:minimumSystemVersion>
      <pubDate>${PUB_DATE}</pubDate>
      <description><![CDATA[
        ${STYLE_BLOCK}
        ${RELEASE_NOTES_HTML}
      ]]></description>
      <enclosure
        url="${DOWNLOAD_URL}"
        sparkle:edSignature="${ED_SIGNATURE}"
        length="${FILE_SIZE}"
        type="application/octet-stream"/>
    </item>
EOF

# Tag the item with a Sparkle channel (stable items stay untagged = default channel)
if [ -n "$CHANNEL" ]; then
  awk -v ch="$CHANNEL" '{print} /<title>/ && !done {print "      <sparkle:channel>" ch "</sparkle:channel>"; done=1}' "$ITEM_FILE" > "${ITEM_FILE}.awk" && mv "${ITEM_FILE}.awk" "$ITEM_FILE"
fi

# Insert new item after the <language> line (before existing items)
# Find the line number of <language> and insert after it
LANG_LINE=$(grep -n '<language>' "$APPCAST_FILE" | head -1 | cut -d: -f1 || echo "")

if [ -z "$LANG_LINE" ]; then
  echo "::error::Could not find <language> tag in $APPCAST_FILE"
  exit 1
fi

{
  head -n "$LANG_LINE" "$APPCAST_FILE"
  cat "$ITEM_FILE"
  tail -n +"$((LANG_LINE + 1))" "$APPCAST_FILE"
} > "${APPCAST_FILE}.tmp" && mv "${APPCAST_FILE}.tmp" "$APPCAST_FILE"

rm -f "$ITEM_FILE"

echo "Updated $APPCAST_FILE with v${VERSION} (build ${BUILD_NUMBER}, size ${FILE_SIZE} bytes)"
