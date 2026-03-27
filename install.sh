#!/usr/bin/env bash
# ============================================================================
# Sulla Desktop — Installer
# ============================================================================
# Downloads and installs the latest pre-built Sulla Desktop from GitHub.
# No build tools required.
#
# Usage:
#   curl -fsSL https://sulladesktop.com/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/install.sh | sh
#
# Or if you already cloned the repo:
#   bash install.sh
#
# Supports macOS (arm64/x86_64), Linux, and Windows (Git Bash / MSYS2).
# ============================================================================

set -euo pipefail

GITHUB_REPO="merchantprotocol/sulla-desktop"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[sulla]${NC} $1"; }
warn()  { echo -e "${YELLOW}[sulla]${NC} $1"; }
error() { echo -e "${RED}[sulla]${NC} $1" >&2; }
info()  { echo -e "${CYAN}[sulla]${NC} $1"; }

# ─── Helpers ─────────────────────────────────────────────────

require_cmd() {
    if ! command -v "$1" &>/dev/null; then
        error "$1 is required but not installed."
        exit 1
    fi
}

# Get the latest release tag from GitHub API
get_latest_release() {
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    local release_json
    release_json=$(curl -fsSL "$api_url" 2>/dev/null) || {
        error "Failed to fetch latest release from GitHub."
        error "Check your internet connection and try again."
        exit 1
    }
    echo "$release_json"
}

# Extract a download URL from release JSON matching a pattern
get_asset_url() {
    local json="$1"
    local pattern="$2"
    echo "$json" \
        | grep -o '"browser_download_url": *"[^"]*'"$pattern"'[^"]*"' \
        | head -1 \
        | sed 's/"browser_download_url": *"//' \
        | sed 's/"$//'
}

# Extract version tag from release JSON
get_release_tag() {
    local json="$1"
    echo "$json" \
        | grep -o '"tag_name": *"[^"]*"' \
        | head -1 \
        | sed 's/"tag_name": *"//' \
        | sed 's/"$//'
}

# ─── macOS installer ────────────────────────────────────────

install_macos() {
    local arch
    arch=$(uname -m)

    local arch_label
    case "$arch" in
        arm64|aarch64) arch_label="aarch64" ;;
        x86_64)        arch_label="x86_64" ;;
        *)
            error "Unsupported macOS architecture: $arch"
            exit 1
            ;;
    esac

    log "Detected macOS ($arch_label)"
    log "Fetching latest release..."

    local release_json
    release_json=$(get_latest_release)
    local version
    version=$(get_release_tag "$release_json")
    log "Latest version: $version"

    # Try DMG first, fall back to ZIP
    local dmg_url
    dmg_url=$(get_asset_url "$release_json" "mac.*\\.dmg")

    if [ -n "$dmg_url" ]; then
        install_macos_dmg "$dmg_url" "$version"
    else
        local zip_url
        zip_url=$(get_asset_url "$release_json" "mac\\.${arch_label}\\.zip\\|mac.*${arch_label}.*\\.zip")
        if [ -z "$zip_url" ]; then
            # Try generic mac zip
            zip_url=$(get_asset_url "$release_json" "mac.*\\.zip")
        fi
        if [ -n "$zip_url" ]; then
            install_macos_zip "$zip_url" "$version"
        else
            error "No macOS artifact found in release $version"
            exit 1
        fi
    fi
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
    mount_point=$(hdiutil attach "$tmp_dmg" -nobrowse -noautoopen 2>/dev/null | grep '/Volumes/' | tail -1 | awk -F'\t' '{print $NF}')

    if [ -z "$mount_point" ]; then
        error "Failed to mount DMG."
        rm -f "$tmp_dmg"
        exit 1
    fi

    local app_name
    app_name=$(ls "$mount_point" | grep '\.app$' | head -1)
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

# ─── Windows installer (Git Bash / MSYS2) ───────────────────

install_windows() {
    log "Detected Windows"
    log "Fetching latest release..."

    local release_json
    release_json=$(get_latest_release)
    local version
    version=$(get_release_tag "$release_json")
    log "Latest version: $version"

    # Prefer MSI installer
    local msi_url
    msi_url=$(get_asset_url "$release_json" "\\.msi")

    if [ -n "$msi_url" ]; then
        install_windows_msi "$msi_url" "$version"
    else
        local zip_url
        zip_url=$(get_asset_url "$release_json" "win.*\\.zip")
        if [ -n "$zip_url" ]; then
            install_windows_zip "$zip_url" "$version"
        else
            error "No Windows artifact found in release $version"
            exit 1
        fi
    fi
}

install_windows_msi() {
    local url="$1"
    local version="$2"
    local tmp_msi="/tmp/SullaDesktop-${version}.msi"

    log "Downloading MSI installer..."
    curl -fSL -o "$tmp_msi" "$url" || {
        error "Download failed."
        exit 1
    }

    log "Running installer (you may see a UAC prompt)..."
    # msiexec runs the MSI; /passive shows progress but no interaction
    cmd.exe /c "msiexec /i \"$(cygpath -w "$tmp_msi")\" /passive" || {
        warn "Silent install failed. Launching interactive installer..."
        cmd.exe /c "msiexec /i \"$(cygpath -w "$tmp_msi")\""
    }
    rm -f "$tmp_msi"

    echo ""
    log "Installation complete!"
    log "Launch Sulla Desktop from the Start menu."
    echo ""
}

install_windows_zip() {
    local url="$1"
    local version="$2"
    local tmp_zip="/tmp/SullaDesktop-${version}-win.zip"

    log "Downloading ZIP..."
    curl -fSL -o "$tmp_zip" "$url" || {
        error "Download failed."
        exit 1
    }

    local install_dir
    install_dir="$(cygpath "$LOCALAPPDATA")/Programs/Sulla Desktop"

    log "Extracting to ${install_dir}..."
    mkdir -p "$install_dir"
    unzip -qo "$tmp_zip" -d "$install_dir"
    rm -f "$tmp_zip"

    echo ""
    log "Installation complete!"
    log "Run: '${install_dir}/Sulla Desktop.exe'"
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
        MINGW*|MSYS*|CYGWIN*)
            log "To uninstall on Windows, use Add/Remove Programs or run:"
            log '  msiexec /x "Sulla Desktop"'
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
            echo "Downloads and installs the latest Sulla Desktop from GitHub."
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
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
        install_windows
        ;;
    *)
        error "Unsupported OS: $OS"
        error "Supported: macOS, Linux, Windows (Git Bash / MSYS2)"
        exit 1
        ;;
esac
