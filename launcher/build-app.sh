#!/bin/bash
# Build the "Sulla Desktop.app" launcher bundle for from-source installs.
# The bundle runs the checkout at ~/.sulla-desktop with `npx electron .`.
# It is generated, not committed: the source of truth is the three files
# next to this script (launcher.sh, Info.plist, SullaDesktop.icns).
# Usage: ./launcher/build-app.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="Sulla Desktop"
APP_BUNDLE="$PROJECT_DIR/${APP_NAME}.app"

echo "Building ${APP_NAME}.app..."

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

cp "$SCRIPT_DIR/Info.plist"        "$APP_BUNDLE/Contents/Info.plist"
cp "$SCRIPT_DIR/SullaDesktop.icns" "$APP_BUNDLE/Contents/Resources/SullaDesktop.icns"
cp "$SCRIPT_DIR/launcher.sh"       "$APP_BUNDLE/Contents/MacOS/launcher"
chmod +x "$APP_BUNDLE/Contents/MacOS/launcher"

echo "  ✓ Built ${APP_NAME}.app at: $APP_BUNDLE"
