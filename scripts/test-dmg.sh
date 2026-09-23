#!/usr/bin/env bash
# Script to test the DMG layout and background alignment without building the entire Xcode app.
set -euo pipefail

# Check if create-dmg is installed
if ! command -v create-dmg >/dev/null 2>&1; then
  echo "Error: 'create-dmg' is not installed."
  echo "Install it using: brew install create-dmg"
  exit 1
fi

echo "Creating temporary build workspace with a valid dummy App bundle..."
TEMP_DIR="temp-dmg-test"
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR/Cinderdeck.app/Contents/MacOS"

# Create dummy executable and Info.plist so Finder parses it as a single valid App
echo '#!/bin/bash' > "$TEMP_DIR/Cinderdeck.app/Contents/MacOS/Cinderdeck"
chmod +x "$TEMP_DIR/Cinderdeck.app/Contents/MacOS/Cinderdeck"

cat > "$TEMP_DIR/Cinderdeck.app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Cinderdeck</string>
    <key>CFBundleIdentifier</key>
    <string>com.cinderdeck.test-layout</string>
    <key>CFBundleName</key>
    <string>Cinderdeck</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
</dict>
</plist>
EOF

# Create build output directory if not exists
mkdir -p build
rm -f build/Cinderdeck-layout-test.dmg

echo "Generating test DMG with create-dmg..."
create-dmg \
  --volname "Cinderdeck Test Layout" \
  --window-size 660 400 \
  --icon-size 120 \
  --icon "Cinderdeck.app" 180 170 \
  --app-drop-link 480 170 \
  --no-internet-enable \
  "build/Cinderdeck-layout-test.dmg" \
  "$TEMP_DIR/Cinderdeck.app"

echo "Cleaning up temporary workspace..."
rm -rf "$TEMP_DIR"

echo "--------------------------------------------------------"
echo "Success! Test DMG created at: build/Cinderdeck-layout-test.dmg"
echo "You can double-click this file in Finder to verify the background and icon alignment."
echo "--------------------------------------------------------"
