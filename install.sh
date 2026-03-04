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
GO_VERSION="1.24.2"

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

ensure_curl() {
  if command_exists curl; then
    ok "curl already installed"
    return
  fi
  info "Installing curl..."
  case "$OS" in
    macos)   ;; # curl ships with macOS
    linux)
      case "$(detect_pkg_manager)" in
        apt)    sudo apt-get update -qq && sudo apt-get install -yqq curl ;;
        dnf)    sudo dnf install -y curl ;;
        yum)    sudo yum install -y curl ;;
        pacman) sudo pacman -Sy --noconfirm curl ;;
        *)      fail "Cannot auto-install curl. Please install it manually." ;;
      esac ;;
    windows) fail "Please install curl manually." ;;
  esac
  command_exists curl || fail "curl installation failed"
  ok "curl installed"
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

ensure_go() {
  local required_major=1
  local required_minor=24

  if command_exists go; then
    local go_ver
    go_ver="$(go version | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/^go//')"
    local cur_major cur_minor
    cur_major="$(echo "$go_ver" | cut -d. -f1)"
    cur_minor="$(echo "$go_ver" | cut -d. -f2)"
    if [ "$cur_major" -gt "$required_major" ] 2>/dev/null || \
       { [ "$cur_major" -eq "$required_major" ] && [ "$cur_minor" -ge "$required_minor" ]; } 2>/dev/null; then
      ok "Go already installed (go$go_ver >= $required_major.$required_minor)"
      return
    fi
    warn "Go go$go_ver found but >= $required_major.$required_minor required — upgrading..."
  else
    info "Installing Go $GO_VERSION..."
  fi

  case "$OS" in
    macos)
      if command_exists brew; then
        brew install go || brew upgrade go
      else
        local arch
        arch="$(uname -m)"
        local go_arch="amd64"
        [ "$arch" = "arm64" ] && go_arch="arm64"
        local go_pkg="go${GO_VERSION}.darwin-${go_arch}.pkg"
        local go_url="https://go.dev/dl/${go_pkg}"
        info "Downloading $go_url ..."
        curl -fsSL -o "/tmp/$go_pkg" "$go_url"
        info "Installing Go via pkg installer (may require password)..."
        sudo installer -pkg "/tmp/$go_pkg" -target /
        rm -f "/tmp/$go_pkg"
        # Ensure Go is on PATH for this session
        export PATH="/usr/local/go/bin:$PATH"
      fi
      ;;
    linux)
      local arch
      arch="$(uname -m)"
      local go_arch="amd64"
      [ "$arch" = "aarch64" ] && go_arch="arm64"
      [ "$arch" = "armv7l" ]  && go_arch="armv6l"
      local go_tar="go${GO_VERSION}.linux-${go_arch}.tar.gz"
      local go_url="https://go.dev/dl/${go_tar}"
      info "Downloading $go_url ..."
      curl -fsSL -o "/tmp/$go_tar" "$go_url"
      info "Extracting to /usr/local/go ..."
      sudo rm -rf /usr/local/go
      sudo tar -C /usr/local -xzf "/tmp/$go_tar"
      rm -f "/tmp/$go_tar"
      export PATH="/usr/local/go/bin:$PATH"
      ;;
    windows)
      fail "Please install Go $GO_VERSION manually from https://go.dev/dl/"
      ;;
  esac

  command_exists go    || fail "Go installation failed — 'go' not found in PATH"
  command_exists gofmt || fail "Go installation failed — 'gofmt' not found in PATH"
  ok "Go $(go version | grep -oE 'go[0-9]+\.[0-9]+\.[0-9]+') installed"
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

  # Always clone into the user's home directory
  local target="$HOME/$REPO_DIR"

  if [ -d "$target" ] && [ -d "$target/.git" ]; then
    # Repo dir exists with a valid .git — just update
    info "Updating existing repo at $target ..."
    cd "$target"
    git pull --ff-only || warn "git pull failed — continuing with existing code"
    REPO_DIR="$(pwd)"
  elif [ -d "$target" ]; then
    # Dir exists but is not a valid git repo (partial clone) — remove and re-clone
    warn "Found incomplete $target from a previous run — removing and re-cloning..."
    rm -rf "$target"
    git clone "$REPO_URL" "$target"
    cd "$target"
    REPO_DIR="$(pwd)"
  else
    info "Cloning sulla-desktop into $target ..."
    git clone "$REPO_URL" "$target"
    cd "$target"
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

  # Always run yarn install — it's already idempotent and handles
  # partially-built states (e.g. node_modules present but Go binaries missing).
  # The postinstall script builds Go binaries, downloads deps, etc.
  info "Installing dependencies (this may take a few minutes on first run)..."
  yarn install --ignore-engines || {
    warn "yarn install failed — retrying with clean state..."
    rm -rf node_modules
    yarn install --ignore-engines
  }
  ok "Dependencies installed"
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

copy_app_to_desktop() {
  if [ "$OS" != "macos" ]; then
    return
  fi

  local source_app="$REPO_DIR/Sulla Desktop.app"
  local desktop_app="$HOME/Desktop/Sulla Desktop.app"

  if [ ! -d "$source_app" ]; then
    warn "Sulla Desktop.app not found at $source_app — skipping Desktop copy"
    return
  fi

  info "Copying Sulla Desktop.app to Desktop..."
  rm -rf "$desktop_app"
  ditto "$source_app" "$desktop_app"
  ok "Desktop app copied to $desktop_app"
}

launch_app() {
  info "Launching Sulla Desktop..."

  # Redirect Electron's stdout/stderr to a log file so it doesn't crash with
  # "write EIO" when the parent shell (e.g. curl | bash pipe) exits.
  local log_dir="$HOME/Library/Logs/Sulla Desktop"
  if [ "$OS" = "linux" ]; then
    log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/sulla-desktop/logs"
  fi
  mkdir -p "$log_dir"
  local log_file="$log_dir/launcher.log"

  NODE_NO_WARNINGS=1 nohup npx electron . >>"$log_file" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  ok "Sulla Desktop running (PID $pid)"
  echo ""
  echo "  Logs:       $log_file"
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
  ensure_curl
  ensure_git
  ensure_node
  ensure_yarn
  ensure_build_tools
  ensure_go
  echo ""

  info "Setting up repository..."
  ensure_repo
  echo ""

  info "Installing & building..."
  install_deps
  build_app
  copy_app_to_desktop
  echo ""

  launch_app

  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  Installation complete! Sulla Desktop is running.          ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
}

main "$@"
