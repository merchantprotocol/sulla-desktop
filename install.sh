#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

# ============================================================================
# Sulla Desktop — Installer
# ============================================================================
# Downloads and installs the latest pre-built Sulla Desktop from the release CDN.
# No build tools required.
#
# Usage:
#   curl -fsSL https://sulladesktop.com/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/install.sh | sh
#
# Or if you already cloned the repo:
#   sh install.sh
#
# Must stay POSIX sh: `curl | sh` on macOS runs bash in POSIX mode, and on
# Linux it runs dash. No bashisms (echo -e, &>, [[ ]], arrays, :: names).
#
# Supports macOS (arm64/x86_64) and Linux.
# ============================================================================

set -eu
# pipefail is not POSIX; use it where the shell supports it.
(set -o pipefail) 2>/dev/null && set -o pipefail

RELEASE_MANIFEST_URL="https://releases.sulladesktop.com/channels/latest/latest.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { printf '%b[sulla]%b %s\n' "$GREEN" "$NC" "$1"; }
warn()  { printf '%b[sulla]%b %s\n' "$YELLOW" "$NC" "$1"; }
error() { printf '%b[sulla]%b %s\n' "$RED" "$NC" "$1" >&2; }
info()  { printf '%b[sulla]%b %s\n' "$CYAN" "$NC" "$1"; }

# ─── Helpers ─────────────────────────────────────────────────

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        error "$1 is required but not installed."
        exit 1
    fi
}

# Fetch the release manifest that the app updater and website also use.
get_latest_release() {
    local release_json
    release_json=$(curl -fsSL "$RELEASE_MANIFEST_URL" 2>/dev/null) || {
        error "Failed to fetch the latest release manifest."
        error "Check your internet connection and try again."
        exit 1
    }
    echo "$release_json"
}

# Extract one architecture entry from the controlled latest.json schema.
get_asset_url() {
    local json="$1"
    local arch="$2"
    echo "$json" | tr '\n' ' ' \
        | sed -n 's/.*"'"$arch"'"[[:space:]]*:[[:space:]]*{[^}]*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

get_release_tag() {
    local json="$1"
    echo "$json" | tr '\n' ' ' \
        | sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# ─── macOS installer ────────────────────────────────────────

# Replacing the app under a running Sulla kills every agent and chat in it.
ensure_sulla_not_running() {
    if pgrep -f "/Applications/Sulla Desktop.app/Contents/MacOS/" >/dev/null 2>&1; then
        error "Sulla Desktop is running. Quit it, then run the installer again."
        exit 1
    fi
}

install_macos() {
    local arch
    arch=$(uname -m)

    # A Rosetta shell reports x86_64 on Apple silicon; ask the hardware.
    if [ "$arch" = "x86_64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
        arch="arm64"
    fi

    # Release assets are named Sulla-Desktop-<ver>-arm64-mac.zip / -x64-mac.zip
    local arch_label
    case "$arch" in
        arm64|aarch64) arch_label="arm64" ;;
        x86_64)        arch_label="x64" ;;
        *)
            error "Unsupported macOS architecture: $arch"
            exit 1
            ;;
    esac

    log "Detected macOS ($arch_label)"
    ensure_sulla_not_running
    log "Fetching latest release..."

    local release_json
    release_json=$(get_latest_release)
    local version
    version=$(get_release_tag "$release_json")
    log "Latest version: $version"

    local zip_url
    zip_url=$(get_asset_url "$release_json" "$arch_label")
    if [ -z "$zip_url" ]; then
        error "No macOS $arch_label artifact found in release $version"
        exit 1
    fi
    install_macos_zip "$zip_url" "$version"
}

install_macos_dmg() {
    local url="$1"
    local version="$2"
    local tmp_dmg="/tmp/SullaDesktop-${version}.dmg"

    log "Downloading DMG..."
    curl -fSL -o "$tmp_dmg" "$url" || {
        error "Download failed."
        exit 1
    }

    log "Mounting DMG..."
    local mount_point
    mount_point=$(hdiutil attach "$tmp_dmg" -nobrowse -noautoopen 2>/dev/null | grep '/Volumes/' | tail -1 | awk -F'\t' '{print $NF}') || true

    if [ -z "$mount_point" ]; then
        error "Failed to mount DMG."
        rm -f "$tmp_dmg"
        exit 1
    fi

    local app_name
    app_name=$(ls "$mount_point" | grep '\.app$' | head -1) || true
    if [ -z "$app_name" ]; then
        error "No .app found in DMG."
        hdiutil detach "$mount_point" -quiet 2>/dev/null || true
        rm -f "$tmp_dmg"
        exit 1
    fi

    log "Installing ${app_name} to /Applications..."
    rm -rf "/Applications/${app_name}"
    cp -R "${mount_point}/${app_name}" /Applications/

    hdiutil detach "$mount_point" -quiet 2>/dev/null || true
    rm -f "$tmp_dmg"

    # Remove quarantine flag so Gatekeeper doesn't block unsigned app
    xattr -cr "/Applications/${app_name}" 2>/dev/null || true

    log "Installed to /Applications/${app_name}"
    finish_macos "$app_name"
}

install_macos_zip() {
    local url="$1"
    local version="$2"
    local tmp_zip="/tmp/SullaDesktop-${version}-mac.zip"

    log "Downloading ZIP..."
    curl -fSL -o "$tmp_zip" "$url" || {
        error "Download failed."
        exit 1
    }

    log "Extracting..."
    local tmp_dir="/tmp/sulla-desktop-extract-$$"
    mkdir -p "$tmp_dir"
    unzip -qo "$tmp_zip" -d "$tmp_dir"
    rm -f "$tmp_zip"

    local app_name
    app_name=$(find "$tmp_dir" -maxdepth 2 -name '*.app' -type d | head -1)
    if [ -z "$app_name" ]; then
        error "No .app found in ZIP."
        rm -rf "$tmp_dir"
        exit 1
    fi

    local basename_app
    basename_app=$(basename "$app_name")

    log "Installing ${basename_app} to /Applications..."
    rm -rf "/Applications/${basename_app}"
    mv "$app_name" /Applications/
    rm -rf "$tmp_dir"

    # Remove quarantine flag so Gatekeeper doesn't block unsigned app
    xattr -cr "/Applications/${basename_app}" 2>/dev/null || true

    log "Installed to /Applications/${basename_app}"
    finish_macos "$basename_app"
}

finish_macos() {
    local app_name="$1"
    echo ""
    log "Installation complete!"
    log "Launch from Applications or run:"
    log "  open '/Applications/${app_name}'"
    echo ""
}

# ─── Linux installer ────────────────────────────────────────

install_linux() {
    log "Detected Linux"
    log "Fetching latest release..."

    local release_json
    release_json=$(get_latest_release)
    local version
    version=$(get_release_tag "$release_json")
    log "Latest version: $version"

    local zip_url
    zip_url=$(get_asset_url "$release_json" "linux.*\\.zip")
    if [ -z "$zip_url" ]; then
        error "No Linux artifact found in release $version"
        exit 1
    fi

    local tmp_zip="/tmp/sulla-desktop-${version}-linux.zip"
    log "Downloading..."
    curl -fSL -o "$tmp_zip" "$zip_url" || {
        error "Download failed."
        exit 1
    }

    local install_dir="/opt/sulla-desktop"

    log "Installing to ${install_dir}..."
    sudo mkdir -p "$install_dir"
    sudo unzip -qo "$tmp_zip" -d "$install_dir"
    rm -f "$tmp_zip"

    # Find the executable
    local exe
    exe=$(find "$install_dir" -maxdepth 2 -name 'sulla-desktop' -type f | head -1)
    if [ -z "$exe" ]; then
        exe=$(find "$install_dir" -maxdepth 2 -name 'Sulla*' -type f -executable | head -1)
    fi

    if [ -n "$exe" ]; then
        sudo chmod +x "$exe"
        sudo ln -sf "$exe" /usr/local/bin/sulla-desktop 2>/dev/null || true

        # Create .desktop entry
        local desktop_file="/usr/share/applications/sulla-desktop.desktop"
        sudo tee "$desktop_file" > /dev/null << DESKTOP
[Desktop Entry]
Name=Sulla Desktop
Exec=${exe}
Terminal=false
Type=Application
Categories=Utility;
DESKTOP
        log "Desktop entry created."
    fi

    echo ""
    log "Installation complete!"
    log "Run: sulla-desktop"
    echo ""
}

# ─── Uninstall ───────────────────────────────────────────────

uninstall() {
    local os
    os=$(uname -s)

    case "$os" in
        Darwin)
            log "Removing Sulla Desktop from /Applications..."
            rm -rf "/Applications/Sulla Desktop.app"
            log "Uninstall complete."
            ;;
        Linux)
            log "Removing Sulla Desktop..."
            sudo rm -rf /opt/sulla-desktop
            sudo rm -f /usr/local/bin/sulla-desktop
            sudo rm -f /usr/share/applications/sulla-desktop.desktop
            log "Uninstall complete."
            ;;
        *)
            error "Unknown OS: $os"
            exit 1
            ;;
    esac
}

# ─── Main ────────────────────────────────────────────────────

for arg in "$@"; do
    case "$arg" in
        --uninstall)
            uninstall
            exit 0
            ;;
        --help|-h)
            echo "Usage: install.sh [--uninstall]"
            echo ""
            echo "Downloads and installs the latest Sulla Desktop from releases.sulladesktop.com."
            echo ""
            echo "  --uninstall   Remove Sulla Desktop"
            echo ""
            echo "For developer builds from source, use install-dev.sh instead."
            exit 0
            ;;
    esac
done

require_cmd curl

log "Sulla Desktop Installer"
echo ""

OS="$(uname -s)"

case "$OS" in
    Darwin)
        install_macos
        ;;
    Linux)
        install_linux
        ;;
    *)
        error "Unsupported OS: $OS"
        error "Supported: macOS, Linux"
        exit 1
        ;;
esac
