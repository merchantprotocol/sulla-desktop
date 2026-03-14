#!/usr/bin/env bash
# ============================================================================
# Sulla Desktop — One-Line Installer
# ============================================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sulla-ai/sulla-desktop/main/install.sh | bash
#
# Install nightly (latest from main, may be unstable):
#   curl -fsSL https://raw.githubusercontent.com/sulla-ai/sulla-desktop/main/install.sh | bash -s -- --nightly
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
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
REPO_URL="https://github.com/sulla-ai/sulla-desktop.git"
REPO_OWNER="sulla-ai"
REPO_NAME="sulla-desktop"
REPO_DIR="sulla-desktop"
NODE_VERSION="22.22.0"
GO_VERSION="1.24.2"
MIN_DISK_GB=10  # minimum free disk space in GB
USE_NIGHTLY=false  # set to true with --nightly flag

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

# Get total system RAM in GB (integer, rounded down)
get_ram_gb() {
  case "$OS" in
    macos)   sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d", $1/1073741824}' ;;
    linux)   awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo 2>/dev/null ;;
    windows)
      # Git Bash / MSYS2: use wmic
      local kb
      kb="$(wmic OS get TotalVisibleMemorySize /value 2>/dev/null | grep -oE '[0-9]+' | head -1)" || true
      if [ -n "${kb:-}" ]; then
        echo $(( kb / 1048576 ))
      else
        echo "8" # safe fallback
      fi
      ;;
  esac
}

# Get available disk space in GB for a given path
get_free_disk_gb() {
  local target="${1:-.}"
  case "$OS" in
    macos|linux)
      df -BG "$target" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}' \
        || df -k "$target" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}'
      ;;
    windows)
      # Git Bash: df reports in 1K blocks
      df -k "$target" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}' || echo "999"
      ;;
  esac
}

# Get the platform-appropriate log directory
get_log_dir() {
  case "$OS" in
    macos)   echo "$HOME/Library/Logs/Sulla Desktop" ;;
    linux)   echo "${XDG_STATE_HOME:-$HOME/.local/state}/sulla-desktop/logs" ;;
    windows) echo "${APPDATA:-$HOME/AppData/Roaming}/Sulla Desktop/logs" ;;
  esac
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
preflight_disk_space() {
  local target="${1:-$HOME}"
  local free_gb
  free_gb="$(get_free_disk_gb "$target")"

  if [ -n "$free_gb" ] && [ "$free_gb" -lt "$MIN_DISK_GB" ] 2>/dev/null; then
    fail "Not enough disk space. Need at least ${MIN_DISK_GB} GB free, only ${free_gb} GB available."
  fi
  ok "Disk space: ${free_gb:-?} GB available (need ${MIN_DISK_GB} GB)"
}

preflight_display() {
  if [ "$OS" != "linux" ]; then
    return
  fi
  # Electron needs a display server (X11 or Wayland)
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    warn "No DISPLAY or WAYLAND_DISPLAY set. Sulla Desktop requires a graphical environment."
    warn "If you are on a headless server, you will not be able to launch the app."
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

# nvm (macOS/Linux only — Windows uses fnm)
ensure_nvm() {
  if [ "$OS" = "windows" ]; then
    return  # Windows uses fnm instead
  fi
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

# fnm (Fast Node Manager — works on Windows Git Bash/MSYS2 where nvm doesn't)
ensure_fnm() {
  if command_exists fnm; then
    ok "fnm already installed"
    return
  fi
  info "Installing fnm (Fast Node Manager for Windows)..."
  # fnm provides a Windows installer via PowerShell
  if command_exists powershell.exe; then
    powershell.exe -Command "irm https://fnm.vercel.app/install | iex" || {
      warn "fnm PowerShell install failed, trying cargo..."
      if command_exists cargo; then
        cargo install fnm
      else
        fail "Cannot install fnm. Please install it manually: https://github.com/Schniz/fnm#installation"
      fi
    }
  elif command_exists cargo; then
    cargo install fnm
  else
    fail "Cannot install fnm. Please install it manually: https://github.com/Schniz/fnm#installation"
  fi

  # Add fnm to PATH for this session
  eval "$(fnm env --shell bash 2>/dev/null)" || true
  command_exists fnm || fail "fnm installation failed"
  ok "fnm installed"
}

ensure_node() {
  if [ "$OS" = "windows" ]; then
    ensure_fnm
    local current=""
    if command_exists node; then
      current="$(node -v | sed 's/^v//')"
    fi
    if [ "$current" = "$NODE_VERSION" ]; then
      ok "Node.js v${current} already installed"
      return
    fi
    if [ -n "$current" ]; then
      info "Node.js v${current} found but v${NODE_VERSION} required — switching..."
    else
      info "Installing Node.js v${NODE_VERSION} via fnm..."
    fi
    fnm install "$NODE_VERSION"
    fnm use "$NODE_VERSION"
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    ok "Node.js $(node -v) active"
  else
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
  fi
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
    windows)
      # curl is bundled with Windows 10+ and Git Bash
      warn "curl not found. It should be bundled with Git for Windows."
      warn "Please reinstall Git for Windows or install curl manually."
      fail "curl is required."
      ;;
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
      command_exists make    || pkgs_needed="$pkgs_needed build-essential"
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
      # Check if cl.exe (MSVC) is available — indicates VS Build Tools installed
      if command_exists cl || [ -d "${PROGRAMFILES:-C:\\Program Files}/Microsoft Visual Studio" ]; then
        ok "Visual Studio Build Tools detected"
      else
        warn "Visual Studio Build Tools not detected."
        warn "If native module compilation fails, install them from:"
        warn "  https://visualstudio.microsoft.com/visual-cpp-build-tools/"
        warn "  Select 'Desktop development with C++' workload."
        # Also try the npm windows-build-tools package as a convenience
        info "Attempting to install build tools via npm..."
        npm install --global windows-build-tools 2>/dev/null || {
          warn "Automatic build tools install failed. Please install manually if needed."
        }
      fi
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
        # Pin to the required version to avoid installing a too-new or too-old Go
        brew install "go@${required_major}.${required_minor}" 2>/dev/null \
          || brew install go 2>/dev/null \
          || brew upgrade go
        # Link versioned formula if it was installed as go@1.24
        brew link --overwrite "go@${required_major}.${required_minor}" 2>/dev/null || true
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
      local arch
      arch="$(uname -m)"
      local go_arch="amd64"
      [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ] && go_arch="arm64"
      local go_msi="go${GO_VERSION}.windows-${go_arch}.msi"
      local go_url="https://go.dev/dl/${go_msi}"
      info "Downloading $go_url ..."
      curl -fsSL -o "/tmp/$go_msi" "$go_url"
      info "Installing Go via MSI (may require elevation)..."
      # msiexec needs a Windows-style path
      local win_path
      win_path="$(cygpath -w "/tmp/$go_msi" 2>/dev/null || echo "/tmp/$go_msi")"
      msiexec.exe /i "$win_path" /quiet /norestart 2>/dev/null || {
        warn "Silent MSI install failed. Please run the installer manually: /tmp/$go_msi"
        warn "Or download from https://go.dev/dl/"
      }
      rm -f "/tmp/$go_msi"
      # Refresh PATH (Go installs to C:\Go\bin on Windows)
      export PATH="/c/Go/bin:$PATH"
      ;;
  esac

  command_exists go    || fail "Go installation failed — 'go' not found in PATH"
  command_exists gofmt || fail "Go installation failed — 'gofmt' not found in PATH"
  ok "Go $(go version | grep -oE 'go[0-9]+\.[0-9]+\.[0-9]+') installed"
}

# Check for Python 3.10+ (needed for training — warn early, don't block install)
check_python() {
  local python_cmd=""
  for cmd in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command_exists "$cmd"; then
      local ver
      ver="$($cmd --version 2>/dev/null | grep -oE '3\.[0-9]+' | head -1)" || continue
      local minor
      minor="$(echo "$ver" | cut -d. -f2)"
      if [ "${minor:-0}" -ge 10 ] 2>/dev/null; then
        python_cmd="$cmd"
        break
      fi
    fi
  done

  if [ -n "$python_cmd" ]; then
    ok "Python 3.10+ found ($($python_cmd --version)) — training features available"
  else
    warn "Python 3.10+ not found. Training features will not work until you install it."
    warn "  macOS:   brew install python@3.12"
    warn "  Linux:   sudo apt install python3.12  (or equivalent)"
    warn "  Windows: https://www.python.org/downloads/"
  fi
}

# ---------------------------------------------------------------------------
# Resolve the target version (latest release tag, or main for nightly)
# ---------------------------------------------------------------------------
resolve_version() {
  if [ "$USE_NIGHTLY" = true ]; then
    INSTALL_REF="main"
    info "Nightly mode — will install from main branch"
    return
  fi

  info "Checking for latest release..."
  local api_url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
  local release_json
  release_json="$(curl -fsSL "$api_url" 2>/dev/null)" || {
    warn "Could not fetch latest release from GitHub API."
    warn "Falling back to main branch."
    INSTALL_REF="main"
    return
  }

  # Extract tag_name from JSON without jq (portable)
  INSTALL_REF="$(echo "$release_json" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"

  if [ -z "$INSTALL_REF" ]; then
    warn "No releases found — falling back to main branch."
    INSTALL_REF="main"
    return
  fi

  ok "Latest release: $INSTALL_REF"
}

# ---------------------------------------------------------------------------
# Clone / update repo
# ---------------------------------------------------------------------------
ensure_repo() {
  # If we're already inside the sulla-desktop repo, use that
  if [ -f "package.json" ] && grep -q '"sulla-desktop"' package.json 2>/dev/null; then
    REPO_DIR="$(pwd)"
    ok "Already inside sulla-desktop repo"
    checkout_version
    return
  fi

  # Always clone into the user's home directory
  local target="$HOME/$REPO_DIR"

  if [ -d "$target" ] && [ -d "$target/.git" ]; then
    # Repo dir exists with a valid .git — just update
    info "Updating existing repo at $target ..."
    cd "$target"
    git fetch --tags --force 2>/dev/null || warn "git fetch failed — continuing with existing code"
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

  checkout_version
  ok "Repo ready at $REPO_DIR ($INSTALL_REF)"
}

# ---------------------------------------------------------------------------
# Checkout the resolved version (release tag or main)
# ---------------------------------------------------------------------------
checkout_version() {
  if [ "$INSTALL_REF" = "main" ]; then
    # Nightly: stay on main, pull latest
    git checkout main 2>/dev/null || true
    local stashed=false
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
      warn "Local changes detected — stashing before update..."
      git stash --include-untracked 2>/dev/null && stashed=true
    fi
    git pull --ff-only || {
      warn "git pull --ff-only failed — trying rebase..."
      git pull --rebase || warn "git pull failed — continuing with existing code"
    }
    if [ "$stashed" = true ]; then
      git stash pop 2>/dev/null || warn "Could not restore stashed changes (may need manual 'git stash pop')"
    fi
  else
    # Release: checkout the tag (detached HEAD is fine for end users)
    local current_tag
    current_tag="$(git describe --tags --exact-match 2>/dev/null || true)"
    if [ "$current_tag" = "$INSTALL_REF" ]; then
      ok "Already on $INSTALL_REF"
      return
    fi
    info "Checking out release $INSTALL_REF ..."
    git checkout "$INSTALL_REF" 2>/dev/null || {
      warn "Could not checkout $INSTALL_REF — trying to fetch it..."
      git fetch origin "refs/tags/$INSTALL_REF:refs/tags/$INSTALL_REF" 2>/dev/null || true
      git checkout "$INSTALL_REF" || fail "Failed to checkout release $INSTALL_REF"
    }
  fi
}

# ---------------------------------------------------------------------------
# Install deps, build, launch
# ---------------------------------------------------------------------------
install_deps() {
  # Remove stale package-lock.json (we use yarn.lock)
  [ -f "package-lock.json" ] && rm -f package-lock.json

  # Ensure Node version manager has the right Node active in this shell
  if [ "$OS" = "windows" ]; then
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    fnm use "$NODE_VERSION" >/dev/null 2>&1 || true
  else
    ensure_nvm
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || true
  fi

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
    return
  fi

  # Clean up partial build artifacts from a failed previous run
  if [ -d "dist" ]; then
    warn "Found incomplete build from a previous run — cleaning up..."
    rm -rf dist
  fi

  # Scale --max-old-space-size to available RAM (leave 2 GB for OS)
  local ram_gb
  ram_gb="$(get_ram_gb)"
  local heap_mb=8192  # default 8 GB
  if [ "${ram_gb:-0}" -le 8 ] 2>/dev/null; then
    heap_mb=4096
  elif [ "${ram_gb:-0}" -le 16 ] 2>/dev/null; then
    heap_mb=8192
  else
    heap_mb=12288
  fi
  info "Building Sulla Desktop (heap=${heap_mb}MB, this may take several minutes)..."
  NODE_OPTIONS="--max-old-space-size=$heap_mb" yarn build

  # Verify build succeeded
  if [ ! -f "dist/app/background.js" ]; then
    fail "Build failed — dist/app/background.js not found. Check build output above."
  fi
  ok "Build complete"
}

create_shortcut() {
  case "$OS" in
    macos)
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
      ;;
    linux)
      local desktop_file="$HOME/.local/share/applications/sulla-desktop.desktop"
      mkdir -p "$(dirname "$desktop_file")"
      cat > "$desktop_file" <<DESKTOP
[Desktop Entry]
Name=Sulla Desktop
Comment=Personal AI Assistant
Exec=bash -c 'cd "$REPO_DIR" && NODE_NO_WARNINGS=1 npx electron .'
Icon=$REPO_DIR/assets/logo-robot-light-nobg.png
Terminal=false
Type=Application
Categories=Utility;Development;
StartupNotify=true
DESKTOP
      # Update desktop database if available
      command_exists update-desktop-database && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
      ok "Linux .desktop entry created at $desktop_file"
      ;;
    windows)
      # Create a shortcut on the Windows Desktop via PowerShell
      local desktop_path
      desktop_path="$(cmd.exe /C 'echo %USERPROFILE%\Desktop' 2>/dev/null | tr -d '\r')" \
        || desktop_path="$HOME/Desktop"
      local repo_win_path
      repo_win_path="$(cygpath -w "$REPO_DIR" 2>/dev/null || echo "$REPO_DIR")"

      if command_exists powershell.exe; then
        powershell.exe -NoProfile -Command "
          \$ws = New-Object -ComObject WScript.Shell;
          \$sc = \$ws.CreateShortcut('${desktop_path}\\Sulla Desktop.lnk');
          \$sc.TargetPath = 'cmd.exe';
          \$sc.Arguments = '/c cd /d \"${repo_win_path}\" && npx electron .';
          \$sc.WorkingDirectory = '${repo_win_path}';
          \$sc.Description = 'Sulla Desktop — Personal AI Assistant';
          \$sc.Save()
        " 2>/dev/null && ok "Windows desktop shortcut created" \
          || warn "Could not create desktop shortcut automatically"
      else
        warn "PowerShell not available — skipping desktop shortcut creation"
      fi
      ;;
  esac
}

launch_app() {
  info "Launching Sulla Desktop..."

  local log_dir
  log_dir="$(get_log_dir)"
  mkdir -p "$log_dir"
  local log_file="$log_dir/launcher.log"

  case "$OS" in
    macos|linux)
      # Redirect Electron's stdout/stderr to a log file so it doesn't crash with
      # "write EIO" when the parent shell (e.g. curl | bash pipe) exits.
      NODE_NO_WARNINGS=1 nohup npx electron . >>"$log_file" 2>&1 &
      local pid=$!
      disown "$pid" 2>/dev/null || true
      ok "Sulla Desktop running (PID $pid)"
      echo ""
      echo "  Logs:       $log_file"
      echo "  To stop:    kill $pid"
      echo "  To restart: cd $REPO_DIR && NODE_NO_WARNINGS=1 npx electron ."
      echo ""
      ;;
    windows)
      # On Windows (Git Bash/MSYS2), nohup/disown may not work reliably.
      # Use start to launch in a new detached process.
      local repo_win_path
      repo_win_path="$(cygpath -w "$REPO_DIR" 2>/dev/null || echo "$REPO_DIR")"
      local log_win_path
      log_win_path="$(cygpath -w "$log_file" 2>/dev/null || echo "$log_file")"

      cmd.exe /C "start /B cmd /C \"cd /d ${repo_win_path} && set NODE_NO_WARNINGS=1 && npx electron . >> ${log_win_path} 2>&1\"" 2>/dev/null \
        || NODE_NO_WARNINGS=1 npx electron . >>"$log_file" 2>&1 &
      ok "Sulla Desktop launched"
      echo ""
      echo "  Logs:       $log_file"
      echo "  To restart: cd $REPO_DIR && npx electron ."
      echo ""
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  # Parse flags
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

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║            Sulla Desktop — Installer                       ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  OS="$(detect_os)"
  info "Detected OS: $OS ($(uname -m))"
  echo ""

  info "Pre-flight checks..."
  preflight_disk_space "$HOME"
  preflight_display
  echo ""

  info "Checking dependencies..."
  ensure_curl
  ensure_git
  ensure_node
  ensure_yarn
  ensure_build_tools
  ensure_go
  check_python
  echo ""

  info "Resolving target version..."
  resolve_version
  echo ""

  info "Setting up repository..."
  ensure_repo
  echo ""

  info "Installing & building..."
  install_deps
  build_app
  create_shortcut
  echo ""

  launch_app

  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  Installation complete! Sulla Desktop is running.            ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
}

main "$@"
