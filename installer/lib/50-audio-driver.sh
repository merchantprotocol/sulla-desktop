#!/usr/bin/env bash
# ============================================================================
# 50-audio-driver.sh — Audio Driver Installation
# ============================================================================
# Installs the sulla-audio driver as a post-build step. The audio driver
# captures system audio (speaker output) for secretary mode transcription.
#
# On macOS this installs:
#   - BlackHole 2ch virtual audio device
#   - Multi-Output Device (mirrors speakers → BlackHole)
#   - audio-driver binary → /usr/local/bin/
#   - LaunchAgent for auto-start
#
# On Windows:
#   - audio-driver binary (WASAPI loopback, no extra drivers needed)
#
# On Linux:
#   - Skipped (not yet supported)
# ============================================================================

AUDIO_DRIVER_REPO="https://github.com/merchantprotocol/sulla-audio.git"
AUDIO_DRIVER_DIR="${HOME}/.sulla-audio"

# ---------------------------------------------------------------------------
# Main entry point — called from controller.sh
# ---------------------------------------------------------------------------
audio_driver::run() {
  log AUDIO "=== Audio driver installation started ==="
  section "Audio Driver"

  # Linux: not supported yet
  if [ "$OS" = "linux" ]; then
    log AUDIO "Audio driver not supported on Linux — skipping"
    step_ok "Audio driver: skipped (Linux not yet supported)"
    return 0
  fi

  start_spinner "Checking audio driver..."

  # Check if audio-driver is already installed and up to date
  if audio_driver::is_current; then
    stop_spinner
    step_ok "Audio driver: up to date"
    log AUDIO "Audio driver already installed and current — nothing to do"
    return 0
  fi

  stop_spinner

  # Clone or update the repo
  audio_driver::ensure_repo

  # Run the platform installer (handles build, BlackHole, service, etc.)
  audio_driver::install

  log AUDIO "=== Audio driver installation finished ==="
}

# ---------------------------------------------------------------------------
# Check if audio-driver binary exists and matches the repo HEAD
# ---------------------------------------------------------------------------
audio_driver::is_current() {
  # Binary must exist
  if [ ! -x "/usr/local/bin/audio-driver" ]; then
    log AUDIO "Binary not found at /usr/local/bin/audio-driver"
    return 1
  fi

  # Repo must exist so we can compare versions
  if [ ! -d "$AUDIO_DRIVER_DIR/.git" ]; then
    log AUDIO "Repo not found at $AUDIO_DRIVER_DIR"
    return 1
  fi

  # Compare installed version commit with repo HEAD
  local installed_commit repo_commit
  installed_commit=$(/usr/local/bin/audio-driver --version 2>/dev/null | grep -oE '[0-9a-f]{7,}' | head -1 || echo "")
  repo_commit=$(cd "$AUDIO_DRIVER_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "")

  if [ -z "$installed_commit" ] || [ -z "$repo_commit" ]; then
    log AUDIO "Cannot compare versions: installed='$installed_commit' repo='$repo_commit'"
    return 1
  fi

  if [ "$installed_commit" = "$repo_commit" ]; then
    log AUDIO "Versions match: $installed_commit"
    return 0
  fi

  log AUDIO "Version mismatch: installed=$installed_commit repo=$repo_commit"
  return 1
}

# ---------------------------------------------------------------------------
# Clone or update the sulla-audio repository
# ---------------------------------------------------------------------------
audio_driver::ensure_repo() {
  if [ -d "$AUDIO_DRIVER_DIR/.git" ]; then
    log AUDIO "Updating existing repo at $AUDIO_DRIVER_DIR"
    start_spinner "Updating audio driver repository..."
    (
      cd "$AUDIO_DRIVER_DIR" &&
      git fetch origin --quiet &&
      git reset --hard origin/main --quiet
    ) 2>&1 | while IFS= read -r line; do log AUDIO "  git: $line"; done
    stop_spinner
    step_ok "Audio driver repo: updated"
  else
    log AUDIO "Cloning $AUDIO_DRIVER_REPO → $AUDIO_DRIVER_DIR"
    start_spinner "Cloning audio driver repository..."
    if git clone --depth 1 "$AUDIO_DRIVER_REPO" "$AUDIO_DRIVER_DIR" >/dev/null 2>&1; then
      stop_spinner
      step_ok "Audio driver repo: cloned"
    else
      stop_spinner
      step_fail "Failed to clone audio driver repository"
      return 1
    fi
  fi
}

# ---------------------------------------------------------------------------
# Run the platform-specific installer
# ---------------------------------------------------------------------------
audio_driver::install() {
  local installer=""

  case "$OS" in
    macos)
      installer="$AUDIO_DRIVER_DIR/installer/macos/install.sh"
      ;;
    windows)
      installer="$AUDIO_DRIVER_DIR/installer/windows/install.bat"
      ;;
    *)
      log AUDIO "No installer for OS=$OS"
      step_ok "Audio driver: skipped (unsupported platform)"
      return 0
      ;;
  esac

  if [ ! -f "$installer" ]; then
    log AUDIO "Installer not found: $installer"
    step_fail "Audio driver installer not found at $installer"
    return 1
  fi

  log AUDIO "Running installer: $installer"
  start_spinner "Installing audio driver (this may take a moment)..."

  # The audio driver installer requires sudo (installs binary to /usr/local/bin,
  # creates LaunchAgent, installs BlackHole). We already have sudo from the
  # main installer flow.
  local install_log="/tmp/sulla-audio-install.log"

  case "$OS" in
    macos)
      if sudo bash "$installer" > "$install_log" 2>&1; then
        stop_spinner
        step_ok "Audio driver: installed"
        log AUDIO "Installer completed successfully"
        # Log the installer output for debugging
        while IFS= read -r line; do log AUDIO "  installer: $line"; done < "$install_log"
      else
        stop_spinner
        log AUDIO "Installer failed — output:"
        while IFS= read -r line; do log AUDIO "  installer: $line"; done < "$install_log"
        step_fail "Audio driver installation failed (see log: $install_log)"
        return 1
      fi
      ;;
    windows)
      # Windows installer is a .bat — run via cmd
      if cmd.exe /c "$installer" > "$install_log" 2>&1; then
        stop_spinner
        step_ok "Audio driver: installed"
      else
        stop_spinner
        step_fail "Audio driver installation failed (see log: $install_log)"
        return 1
      fi
      ;;
  esac

  # Verify the binary is installed
  if [ -x "/usr/local/bin/audio-driver" ]; then
    local version
    version=$(/usr/local/bin/audio-driver --version 2>/dev/null | head -1 || echo "unknown")
    step_ok "Audio driver binary: $version"
    log AUDIO "Binary verified: $version"
  else
    log AUDIO "Binary not found after installation — may need reboot"
    step_ok "Audio driver: installed (may need reboot to activate)"
  fi

  # macOS: verify the socket comes up (service is running)
  if [ "$OS" = "macos" ]; then
    local tries=0
    while [ $tries -lt 5 ]; do
      if [ -S /tmp/audio-driver.sock ]; then
        step_ok "Audio driver service: running"
        log AUDIO "Socket /tmp/audio-driver.sock is live"
        return 0
      fi
      sleep 1
      tries=$((tries + 1))
    done
    log AUDIO "Socket not available after 5s — service may need manual start"
    step_ok "Audio driver: installed (service may need restart after reboot)"
  fi
}
