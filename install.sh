#!/usr/bin/env bash
# ============================================================================
# Sulla Desktop — One-Line Installer (Bootstrap)
# ============================================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/install.sh | bash
#
# Install nightly (latest from main, may be unstable):
#   curl -fsSL https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/install.sh | bash -s -- --nightly
#
# Or if you already cloned the repo:
#   bash install.sh
#   bash install.sh --nightly
#
# Options:
#   --nightly   Install from the latest main branch instead of the latest release.
#               Use this if you want bleeding-edge features (may be unstable).
#
# Idempotent — safe to run multiple times.
# Supports macOS (arm64/x86_64), Linux (apt/dnf/pacman), and Windows (Git Bash / MSYS2).
#
# Architecture:
#   Phase 1 (this file): Bootstrap — detect OS, install git/curl, clone repo.
#   Phase 2 (installer/): Source modular lib from cloned repo, run controller.
# ============================================================================

set -euo pipefail

# ============================================================================
# Phase 1: Inline Bootstrap
# ============================================================================
# These minimal definitions run BEFORE the repo is cloned. They are
# overwritten by the full versions in installer/lib/ after cloning.
# ============================================================================

# --- Bootstrap logging (before lib modules are available) ---
INSTALL_LOG="/tmp/sulla-install.log"
: > "$INSTALL_LOG"
_log() { printf "[%s] [%-8s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" >> "$INSTALL_LOG"; }

_log BOOT "Sulla Desktop installer starting"
_log BOOT "Arguments: $*"
_log BOOT "Shell: $SHELL (bash $BASH_VERSION)"
_log BOOT "User: $(whoami), HOME=$HOME"

# --- Config ---
REPO_URL="https://github.com/merchantprotocol/sulla-desktop.git"
REPO_OWNER="merchantprotocol"
REPO_NAME="sulla-desktop"
INSTALL_DIR="$HOME/.sulla-desktop"
USE_NIGHTLY=false
INSTALL_FAILED=false

for arg in "$@"; do
  case "$arg" in
    --nightly) USE_NIGHTLY=true ;;
    --help|-h)
      echo "Usage: install.sh [--nightly]"
      echo ""
      echo "  --nightly   Install from the latest main branch (may be unstable)"
      echo "              Default: installs the latest stable release"
      exit 0
      ;;
  esac
done

# --- Inline colors ---
_BOLD="\033[1m"
_DIM="\033[2m"
_RESET="\033[0m"
_GREEN="\033[1;32m"
_RED="\033[1;31m"
_YELLOW="\033[1;33m"
_CYAN="\033[1;36m"
_WHITE="\033[1;37m"
_CHECK="${_GREEN}✔${_RESET}"
_CROSS="${_RED}✖${_RESET}"

# --- Inline spinner ---
_SPINNER_FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
_SPINNER_PID=""

_hide_cursor() { printf "\033[?25l"; }
_show_cursor() { printf "\033[?25h"; }
_clear_line() { printf "\r\033[2K"; }

_start_spinner() {
  local msg="$1"
  _stop_spinner 2>/dev/null
  (
    local i=0
    while true; do
      local frame="${_SPINNER_FRAMES[$((i % ${#_SPINNER_FRAMES[@]}))]}"
      printf "\r  ${_CYAN}%s${_RESET} %s" "$frame" "$msg"
      sleep 0.08
      i=$((i + 1))
    done
  ) &
  _SPINNER_PID=$!
  disown "$_SPINNER_PID" 2>/dev/null
}

_stop_spinner() {
  if [ -n "${_SPINNER_PID:-}" ] && kill -0 "$_SPINNER_PID" 2>/dev/null; then
    kill "$_SPINNER_PID" 2>/dev/null
    wait "$_SPINNER_PID" 2>/dev/null || true
  fi
  _SPINNER_PID=""
  _clear_line
}

_step_ok() {
  _stop_spinner
  printf "  ${_CHECK}  %s\n" "$1"
}

_step_fail() {
  _stop_spinner
  printf "  ${_CROSS}  %s\n" "$1"
  printf "\n  ${_RED}${_BOLD}Bootstrap failed.${_RESET}\n\n"
  _show_cursor
  exit 1
}

_cleanup() {
  _stop_spinner 2>/dev/null
  _show_cursor
}
trap _cleanup EXIT

# --- PATH Bootstrap ---
_bootstrap_path() {
  local candidates=(
    /opt/homebrew/bin /opt/homebrew/sbin
    /usr/local/bin /usr/local/sbin
    /home/linuxbrew/.linuxbrew/bin /home/linuxbrew/.linuxbrew/sbin
    /usr/local/go/bin "$HOME/go/bin"
    /c/Go/bin "/c/Program Files/Go/bin"
    "$HOME/.cargo/bin"
    /usr/bin /usr/sbin /bin /sbin
  )
  for dir in "${candidates[@]}"; do
    case ":$PATH:" in
      *":$dir:"*) continue ;;
    esac
    [ -d "$dir" ] && export PATH="$dir:$PATH"
  done
}
_bootstrap_path
_log BOOT "PATH bootstrap complete"

# --- OS Detection ---
_detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "macos"  ;;
    Linux*)   echo "linux"  ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)        _step_fail "Unsupported OS: $(uname -s)" ;;
  esac
}

# --- Bootstrap: ensure git + curl exist ---
_command_exists() { command -v "$1" >/dev/null 2>&1; }

_bootstrap_install_curl() {
  local os="$1"
  case "$os" in
    linux)
      if _command_exists apt-get; then
        sudo apt-get update -qq && sudo apt-get install -yqq curl
      elif _command_exists dnf; then
        sudo dnf install -y curl
      elif _command_exists yum; then
        sudo yum install -y curl
      elif _command_exists pacman; then
        sudo pacman -Sy --noconfirm curl
      else
        _step_fail "Cannot install curl — no supported package manager found. Install curl manually and re-run."
      fi
      ;;
    windows)
      _step_fail "curl not found — please install Git for Windows: https://git-scm.com/download/win"
      ;;
    macos)
      _step_fail "curl not found on macOS — this should never happen. Is your system corrupt?"
      ;;
  esac
  _command_exists curl || _step_fail "curl installation failed"
}

_bootstrap_install_git() {
  local os="$1"
  case "$os" in
    macos)
      # Xcode CLT provides git — trigger install dialog
      if ! xcode-select -p >/dev/null 2>&1; then
        xcode-select --install >/dev/null 2>&1 || true
        printf "  ${_YELLOW}⚠${_RESET}  Xcode CLT dialog opened — approve it, then re-run this installer.\n"
        exit 1
      fi
      ;;
    linux)
      if _command_exists apt-get; then
        sudo apt-get update -qq && sudo apt-get install -yqq git
      elif _command_exists dnf; then
        sudo dnf install -y git
      elif _command_exists yum; then
        sudo yum install -y git
      elif _command_exists pacman; then
        sudo pacman -Sy --noconfirm git
      else
        _step_fail "Cannot install git — no supported package manager found. Install git manually and re-run."
      fi
      ;;
    windows)
      _step_fail "git not found — please install Git for Windows: https://git-scm.com/download/win"
      ;;
  esac
  _command_exists git || _step_fail "git installation failed"
}

# ============================================================================
# Phase 1: Execute Bootstrap
# ============================================================================
_hide_cursor
echo ""
printf "  ${_BOLD}${_WHITE}Sulla Desktop${_RESET} ${_DIM}— Bootstrap${_RESET}\n"
echo ""

BOOTSTRAP_OS="$(_detect_os)"
_log BOOT "Detected OS: $BOOTSTRAP_OS ($(uname -m))"
_step_ok "Detected ${BOOTSTRAP_OS} ($(uname -m))"

# Ensure curl
if _command_exists curl; then
  _log BOOT "curl already available: $(command -v curl)"
  _step_ok "curl available"
else
  _log BOOT "curl not found, installing..."
  _start_spinner "Installing curl..."
  _bootstrap_install_curl "$BOOTSTRAP_OS"
  _log BOOT "curl installed: $(command -v curl)"
  _step_ok "curl installed"
fi

# Ensure git
if _command_exists git && git --version >/dev/null 2>&1; then
  _log BOOT "git already available: $(git --version)"
  _step_ok "git available"
else
  _log BOOT "git not found, installing..."
  _start_spinner "Installing git..."
  _bootstrap_install_git "$BOOTSTRAP_OS"
  _log BOOT "git installed: $(git --version)"
  _step_ok "git installed"
fi

# Verify GitHub is reachable before attempting clone
_log BOOT "Checking GitHub connectivity..."
_start_spinner "Checking GitHub connectivity..."
_gh_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}" 2>/dev/null)" || _gh_code="000"
_log BOOT "GitHub API response code: $_gh_code"

if [ "$_gh_code" = "000" ]; then
  _log BOOT "GitHub unreachable (code 000)"
  _step_fail "Cannot reach GitHub — check your internet connection"
elif [ "$_gh_code" -ge 400 ] 2>/dev/null && [ "$_gh_code" != "404" ]; then
  _log BOOT "GitHub returned error: HTTP $_gh_code"
  _step_fail "GitHub returned HTTP ${_gh_code} — check your credentials or rate limits"
fi
_log BOOT "GitHub accessible"
_step_ok "GitHub accessible"

# ============================================================================
# Phase 1.5: Get the repo (so we can source installer/lib/)
# ============================================================================

# If we're already inside the repo, use it directly
if [ -f "package.json" ] && grep -q '"sulla-desktop"' package.json 2>/dev/null; then
  INSTALLER_ROOT="$(pwd)/installer"
  _log BOOT "Running from cloned repo at $(pwd)"
  _step_ok "Running from cloned repo"
elif [ -d "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR/.git" ]; then
  # Repo already exists — update it
  _log BOOT "Existing repo found at $INSTALL_DIR, updating..."
  _start_spinner "Updating repository..."
  cd "$INSTALL_DIR"
  git fetch origin --tags --force >/dev/null 2>&1 || true
  if [ "$USE_NIGHTLY" = true ]; then
    _log BOOT "Nightly mode: resetting to origin/main"
    git checkout main >/dev/null 2>&1 || true
    git reset --hard origin/main >/dev/null 2>&1 || true
  else
    # Resolve latest release tag and checkout so installer code matches the release
    local _release_tag
    _release_tag="$(curl -fsSL "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')" || true
    if [ -n "${_release_tag:-}" ]; then
      _log BOOT "Latest release: $_release_tag — checking out"
      git checkout "$_release_tag" >/dev/null 2>&1 || true
    else
      _log BOOT "Could not resolve latest release — staying on current version"
    fi
  fi
  INSTALLER_ROOT="$(pwd)/installer"
  _log BOOT "Repository updated at $(pwd)"
  _step_ok "Repository updated"
else
  # Fresh clone
  _log BOOT "Cloning repository from $REPO_URL to $INSTALL_DIR"
  _start_spinner "Cloning repository..."
  git clone "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 || _step_fail "git clone failed"
  cd "$INSTALL_DIR"
  INSTALLER_ROOT="$(pwd)/installer"
  _log BOOT "Repository cloned to $(pwd)"
  _step_ok "Repository cloned"
fi

# ============================================================================
# Phase 2: Hand off to modular installer
# ============================================================================

INSTALLER_LIB="$INSTALLER_ROOT/lib"
INSTALLER_CONTROLLER="$INSTALLER_ROOT/controller.sh"

if [ ! -d "$INSTALLER_LIB" ]; then
  _step_fail "installer/lib/ not found in repo — is this a valid sulla-desktop checkout?"
fi

if [ ! -f "$INSTALLER_CONTROLLER" ]; then
  _step_fail "installer/controller.sh not found — is this a valid sulla-desktop checkout?"
fi

_log BOOT "Installer modules found at $INSTALLER_LIB"
_step_ok "Installer modules found"

# Clear the bootstrap trap — the full UI module will set its own
trap - EXIT

# Source all modules in numeric order
_log BOOT "Sourcing installer modules from: $INSTALLER_LIB"
for lib_file in "$INSTALLER_LIB"/*.sh; do
  [ -f "$lib_file" ] || continue
  _log BOOT "Sourcing: $(basename "$lib_file")"
  # shellcheck source=/dev/null
  source "$lib_file"
done

# Source the controller
_log BOOT "Sourcing controller: $INSTALLER_CONTROLLER"
# shellcheck source=/dev/null
source "$INSTALLER_CONTROLLER"

# Capture environment snapshot now that log() is available
_log BOOT "Calling log_env_snapshot"
log_env_snapshot

# Detect OS (now using the full platform module)
OS="$(detect_os)"
_log BOOT "Full OS detection: $OS"

# Validate that the detected OS has a complete module
validate_os_module "$OS"
_log BOOT "OS module validated for: $OS"

# Bootstrap PATH with the full version
bootstrap_path
_log BOOT "Full PATH bootstrap complete"

# Hand off to the controller — this runs the entire install
_log BOOT "Handing off to controller::run"
controller::run "$@"
