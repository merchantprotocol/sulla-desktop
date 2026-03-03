#!/usr/bin/env bash
# ============================================================================
# Sulla Desktop — One-Line Installer
# ============================================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sulla-ai/sulla-desktop/main/install.sh | bash
#
# Or if you already cloned the repo:
#   bash install.sh
#
# Idempotent — safe to run multiple times.
# Supports macOS (arm64/x86_64), Linux (apt/dnf/pacman), and Windows (Git Bash / WSL).
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
REPO_URL="https://github.com/sulla-ai/sulla-desktop.git"
REPO_DIR="sulla-desktop"
NODE_VERSION="22.22.0"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn()  { printf "\033[1;33m⚠ %s\033[0m\n" "$*"; }
fail()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "macos"  ;;
    Linux*)   echo "linux"  ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)        fail "Unsupported OS: $(uname -s)" ;;
  esac
}

detect_pkg_manager() {
  if command_exists apt-get; then echo "apt"
  elif command_exists dnf;     then echo "dnf"
  elif command_exists yum;     then echo "yum"
  elif command_exists pacman;  then echo "pacman"
  elif command_exists brew;    then echo "brew"
  else echo "unknown"
  fi
}

# ---------------------------------------------------------------------------
# Dependency checks & installs
# ---------------------------------------------------------------------------
ensure_git() {
  if command_exists git; then
    ok "git already installed ($(git --version))"
    return
  fi
  info "Installing git..."
  case "$OS" in
    macos)   xcode-select --install 2>/dev/null || true ;;
    linux)
      case "$(detect_pkg_manager)" in
        apt)    sudo apt-get update -qq && sudo apt-get install -yqq git ;;
        dnf)    sudo dnf install -y git ;;
        yum)    sudo yum install -y git ;;
        pacman) sudo pacman -Sy --noconfirm git ;;
        *)      fail "Cannot auto-install git. Please install it manually." ;;
      esac ;;
    windows) fail "Please install Git for Windows: https://git-scm.com/download/win" ;;
  esac
  command_exists git || fail "git installation failed"
  ok "git installed"
}

ensure_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    ok "nvm already installed"
    return
  fi
  info "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  command_exists nvm || fail "nvm installation failed"
  ok "nvm installed"
}

ensure_node() {
  ensure_nvm
  local current=""
  if command_exists node; then
    current="$(node -v | sed 's/^v//')"
  fi
  if [ "$current" = "$NODE_VERSION" ]; then
    ok "Node.js v${current} already installed"
    return
  fi
  if [ -n "$current" ]; then
    info "Node.js v${current} found but v${NODE_VERSION} required — upgrading..."
  else
    info "Installing Node.js v${NODE_VERSION} via nvm..."
  fi
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  ok "Node.js $(node -v) active"
}

ensure_yarn() {
  if command_exists yarn; then
    ok "yarn already installed ($(yarn --version))"
    return
  fi
  info "Installing yarn via corepack..."
  corepack enable 2>/dev/null || npm install -g yarn
  command_exists yarn || fail "yarn installation failed"
  ok "yarn installed"
}

ensure_build_tools() {
  case "$OS" in
    macos)
      if ! xcode-select -p >/dev/null 2>&1; then
        info "Installing Xcode command-line tools (needed for native modules)..."
        xcode-select --install 2>/dev/null || true
        warn "If a dialog appeared, finish the Xcode CLT install and re-run this script."
      else
        ok "Xcode CLT present"
      fi
      ;;
    linux)
      local pkgs_needed=""
      command_exists make  || pkgs_needed="$pkgs_needed build-essential"
      command_exists python3 || pkgs_needed="$pkgs_needed python3"
      if [ -n "$pkgs_needed" ]; then
        info "Installing build tools:$pkgs_needed"
        case "$(detect_pkg_manager)" in
          apt)    sudo apt-get update -qq && sudo apt-get install -yqq $pkgs_needed ;;
          dnf)    sudo dnf install -y gcc gcc-c++ make python3 ;;
          yum)    sudo yum install -y gcc gcc-c++ make python3 ;;
          pacman) sudo pacman -Sy --noconfirm base-devel python ;;
          *)      warn "Please ensure C/C++ build tools are installed." ;;
        esac
      else
        ok "Build tools present"
      fi
      ;;
    windows)
      ok "Build tools check skipped on Windows (use Visual Studio Build Tools if native modules fail)"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Clone / update repo
# ---------------------------------------------------------------------------
ensure_repo() {
  # If we're already inside the sulla-desktop repo, use that
  if [ -f "package.json" ] && grep -q '"sulla-desktop"' package.json 2>/dev/null; then
    REPO_DIR="$(pwd)"
    ok "Already inside sulla-desktop repo"
    return
  fi

  if [ -d "$REPO_DIR" ] && [ -d "$REPO_DIR/.git" ]; then
    # Repo dir exists with a valid .git — just update
    info "Updating existing repo..."
    cd "$REPO_DIR"
    git pull --ff-only || warn "git pull failed — continuing with existing code"
    REPO_DIR="$(pwd)"
  elif [ -d "$REPO_DIR" ]; then
    # Dir exists but is not a valid git repo (partial clone) — remove and re-clone
    warn "Found incomplete $REPO_DIR from a previous run — removing and re-cloning..."
    rm -rf "$REPO_DIR"
    git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
    REPO_DIR="$(pwd)"
  else
    info "Cloning sulla-desktop..."
    git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
    REPO_DIR="$(pwd)"
  fi
  ok "Repo ready at $REPO_DIR"
}

# ---------------------------------------------------------------------------
# Install deps, build, launch
# ---------------------------------------------------------------------------
install_deps() {
  # Remove stale package-lock.json (we use yarn.lock)
  [ -f "package-lock.json" ] && rm -f package-lock.json

  # Ensure nvm has the right Node active in this shell
  # (handles case where nvm was installed earlier in this script but shell lost context)
  ensure_nvm
  nvm use "$NODE_VERSION" >/dev/null 2>&1 || true

  if [ -d "node_modules" ] && [ -d "node_modules/electron" ] && [ -d "node_modules/tsx" ]; then
    ok "node_modules already present — skipping install (run 'yarn install' to refresh)"
  else
    # Clean up partial node_modules from a failed previous run
    if [ -d "node_modules" ]; then
      warn "Found incomplete node_modules from a previous run — cleaning up..."
      rm -rf node_modules
    fi
    info "Installing dependencies (this may take a few minutes)..."
    yarn install --ignore-engines || {
      warn "yarn install failed — retrying with clean state..."
      rm -rf node_modules
      yarn install --ignore-engines
    }
    ok "Dependencies installed"
  fi
}

build_app() {
  if [ -d "dist" ] && [ -f "dist/app/background.js" ]; then
    ok "Build artifacts present — skipping build (run 'yarn build' to rebuild)"
  else
    # Clean up partial build artifacts from a failed previous run
    if [ -d "dist" ]; then
      warn "Found incomplete build from a previous run — cleaning up..."
      rm -rf dist
    fi
    info "Building Sulla Desktop (this may take several minutes)..."
    NODE_OPTIONS="--max-old-space-size=12288" yarn build
    ok "Build complete"
  fi
}

launch_app() {
  info "Launching Sulla Desktop..."
  NODE_NO_WARNINGS=1 npx electron . &
  local pid=$!
  ok "Sulla Desktop running (PID $pid)"
  echo ""
  echo "  To stop:    kill $pid"
  echo "  To restart: cd $REPO_DIR && NODE_NO_WARNINGS=1 npx electron ."
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║            Sulla Desktop — Installer                       ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  OS="$(detect_os)"
  info "Detected OS: $OS ($(uname -m))"
  echo ""

  info "Checking dependencies..."
  ensure_git
  ensure_node
  ensure_yarn
  ensure_build_tools
  echo ""

  info "Setting up repository..."
  ensure_repo
  echo ""

  info "Installing & building..."
  install_deps
  build_app
  echo ""

  launch_app

  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  Installation complete! Sulla Desktop is running.          ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
}

main "$@"
