#!/usr/bin/env bash
# ============================================================================
# 11-os-linux.sh — Linux Platform Module
# ============================================================================
# All Linux-specific logic lives here under the linux:: namespace.
# Implements the required OS interface defined in 02-platform.sh.
# All actions logged with [LINUX] tag.
# ============================================================================

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
linux::preflight() {
  local arch
  arch="$(detect_arch)"
  log LINUX "Preflight: arch=$arch kernel=$(uname -r) distro=$(cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2 | tr -d '"' || echo unknown)"
  step_ok "Detected Linux (${arch})"

  if [ "$arch" = "arm64" ] || [ "$arch" = "aarch64" ]; then
    export M1=true
    log LINUX "ARM architecture detected — exported M1=true"
  fi

  # Display server check
  log LINUX "Display check: DISPLAY=${DISPLAY:-unset} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset}"
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    step_warn "No display server detected — GUI may not work"
  else
    step_ok "Display server available"
  fi
}

# ---------------------------------------------------------------------------
# System info
# ---------------------------------------------------------------------------
linux::get_ram_gb() {
  awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo 2>/dev/null
}

linux::get_free_disk_gb() {
  local target="${1:-.}"
  df -BG "$target" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}' \
    || df -k "$target" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}'
}

linux::get_log_dir() {
  echo "${XDG_STATE_HOME:-$HOME/.local/state}/sulla-desktop/logs"
}

# ---------------------------------------------------------------------------
# Dependency audit
# ---------------------------------------------------------------------------
linux::audit_deps() {
  log LINUX "Starting dependency audit"
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  log LINUX "Detected package manager: $pkg_mgr"

  # curl
  if command_exists curl; then
    dep_found "curl"
    log LINUX "curl: found at $(command -v curl)"
  else
    dep_missing "curl" "not installed"
    log LINUX "curl: NOT found"
  fi

  # git
  if command_exists git && git --version >/dev/null 2>&1; then
    local git_ver
    git_ver="$(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
    dep_found "git" "$git_ver"
    log GIT "git: found v$git_ver at $(command -v git)"
  else
    dep_missing "git" "not installed"
    log GIT "git: NOT found"
  fi

  # Node.js
  log NODE "Sourcing node version manager..."
  linux::_source_node_manager
  local node_current=""
  command_exists node && node_current="$(node -v 2>/dev/null | sed 's/^v//')"
  log NODE "Node.js: current=$node_current required=$NODE_VERSION"

  if [ -n "$node_current" ] && [ "$node_current" = "$NODE_VERSION" ]; then
    dep_found "Node.js" "v${node_current}"
  elif [ -n "$node_current" ]; then
    dep_upgrade "Node.js" "v${node_current} → v${NODE_VERSION}"
  else
    dep_missing "Node.js" "need v${NODE_VERSION}"
  fi

  # yarn
  if command_exists yarn; then
    dep_found "yarn" "$(yarn --version 2>/dev/null)"
    log YARN "yarn: found at $(command -v yarn)"
  else
    dep_missing "yarn" "not installed"
    log YARN "yarn: NOT found"
  fi

  # Build tools
  log LINUX "Checking build tools: make=$(command_exists make && echo yes || echo no) python3=$(command_exists python3 && echo yes || echo no)"
  if command_exists make && command_exists python3; then
    dep_found "Build tools" "make, python3"
  else
    local bt_detail=""
    command_exists make    || bt_detail="make"
    if ! command_exists python3; then
      [ -n "$bt_detail" ] && bt_detail="$bt_detail, "
      bt_detail="${bt_detail}python3"
    fi
    dep_missing "Build tools" "${bt_detail} missing"
  fi

  # Go
  log GO "Searching for Go..."
  linux::_find_go
  if command_exists go; then
    local go_ver go_major go_minor
    go_ver="$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/^go//')"
    go_major="$(echo "$go_ver" | cut -d. -f1)"
    go_minor="$(echo "$go_ver" | cut -d. -f2)"
    log GO "Go: found v$go_ver at $(command -v go)"
    if [ "${go_major:-0}" -gt 1 ] 2>/dev/null || \
       { [ "${go_major:-0}" -eq 1 ] && [ "${go_minor:-0}" -ge 24 ]; } 2>/dev/null; then
      dep_found "Go" "${go_ver}"
    else
      dep_upgrade "Go" "${go_ver} → ${GO_VERSION}"
    fi
  else
    dep_missing "Go" "need ${GO_VERSION}+"
    log GO "Go: NOT found"
  fi

  # Python (optional)
  linux::_check_python

  log LINUX "Dependency audit complete"
}

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
linux::_source_node_manager() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    log NODE "Sourcing nvm from $NVM_DIR/nvm.sh"
    . "$NVM_DIR/nvm.sh" 2>/dev/null || true
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || true
  fi
  if command_exists fnm; then
    log NODE "Sourcing fnm"
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    fnm use "$NODE_VERSION" >/dev/null 2>&1 || true
  fi
}

linux::_find_go() {
  if ! command_exists go; then
    for go_path in /home/linuxbrew/.linuxbrew/bin /usr/local/bin /usr/local/go/bin "$HOME/go/bin"; do
      if [ -x "$go_path/go" ]; then
        log GO "Found go at $go_path/go — adding to PATH"
        export PATH="$go_path:$PATH"
        break
      fi
    done
  fi
}

linux::_check_python() {
  local python_ver=""
  for cmd in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command_exists "$cmd"; then
      local ver minor
      ver="$($cmd --version 2>/dev/null | grep -oE '3\.[0-9]+' | head -1)" || continue
      minor="$(echo "$ver" | cut -d. -f2)"
      if [ "${minor:-0}" -ge 10 ] 2>/dev/null; then
        python_ver="$($cmd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
        log LINUX "Python: found v$python_ver via $cmd"
        break
      fi
    fi
  done
  if [ -n "$python_ver" ]; then
    dep_found "Python" "${python_ver}"
  else
    dep_warn "Python" "3.10+ not found — training features unavailable"
    log LINUX "Python: 3.10+ NOT found"
  fi
}

# ---------------------------------------------------------------------------
# Installers
# ---------------------------------------------------------------------------
linux::install_xcode_clt() {
  # No-op on Linux
  return 0
}

linux::install_curl() {
  log LINUX "Installing curl"
  require_sudo "curl" "is required for downloading packages and needs user authorization to install"
  start_spinner "Installing curl..."

  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  log LINUX "Using package manager: $pkg_mgr"

  case "$pkg_mgr" in
    apt)    run_silent "curl" sudo apt-get update -qq && run_silent "curl" sudo apt-get install -yqq curl ;;
    dnf)    run_silent "curl" sudo dnf install -y curl ;;
    yum)    run_silent "curl" sudo yum install -y curl ;;
    pacman) run_silent "curl" sudo pacman -Sy --noconfirm curl ;;
    *)      assert_fail "Cannot install curl — unsupported package manager '${pkg_mgr}'. Install curl manually and re-run." ;;
  esac

  assert_command_exists curl
  log LINUX "curl installed at $(command -v curl)"
  step_ok "curl installed"
}

linux::install_git() {
  log GIT "Installing git on Linux"
  require_sudo "git" "is required for source control and needs user authorization to install"
  start_spinner "Installing git..."

  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  log GIT "Using package manager: $pkg_mgr"

  case "$pkg_mgr" in
    apt)    run_silent "git" sudo apt-get update -qq && run_silent "git" sudo apt-get install -yqq git ;;
    dnf)    run_silent "git" sudo dnf install -y git ;;
    yum)    run_silent "git" sudo yum install -y git ;;
    pacman) run_silent "git" sudo pacman -Sy --noconfirm git ;;
    *)      assert_fail "Cannot install git — unsupported package manager '${pkg_mgr}'. Install git manually and re-run." ;;
  esac

  assert_command_exists git
  log GIT "git installed: $(git --version) at $(command -v git)"
  step_ok "git installed"
}

linux::install_node() {
  log NODE "Installing Node.js v${NODE_VERSION} on Linux"
  start_spinner "Installing Node.js v${NODE_VERSION}..."

  linux::_install_nvm

  log NODE "Running: nvm install $NODE_VERSION"
  run_silent "node-install" nvm install "$NODE_VERSION"
  run_silent "node-use" nvm use "$NODE_VERSION"

  assert_command_exists node
  local installed_ver
  installed_ver="$(node -v 2>/dev/null | sed 's/^v//')"
  log NODE "Installed: v$installed_ver (expected: v$NODE_VERSION) at $(command -v node)"
  if [ "$installed_ver" != "$NODE_VERSION" ]; then
    assert_fail "Node.js version mismatch: expected v${NODE_VERSION}, got v${installed_ver}"
  fi
  step_ok "Node.js v${installed_ver}"
}

linux::_install_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    log NODE "nvm already installed at $NVM_DIR"
    . "$NVM_DIR/nvm.sh"
    return
  fi
  log NODE "Installing nvm from github"
  run_silent "nvm" bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    assert_fail "nvm installation failed — $NVM_DIR/nvm.sh not found"
  fi
  log NODE "nvm installed, sourcing $NVM_DIR/nvm.sh"
  . "$NVM_DIR/nvm.sh"
}

linux::install_yarn() {
  log YARN "Installing yarn on Linux"
  start_spinner "Installing yarn..."
  run_silent "yarn" bash -c 'corepack enable 2>/dev/null || npm install -g yarn'
  assert_command_exists yarn
  log YARN "Installed: v$(yarn --version) at $(command -v yarn)"
  step_ok "yarn $(yarn --version)"
}

linux::install_build_tools() {
  local pkgs_needed=""
  command_exists make    || pkgs_needed="$pkgs_needed build-essential"
  command_exists python3 || pkgs_needed="$pkgs_needed python3"

  if [ -z "$pkgs_needed" ]; then
    log LINUX "Build tools already installed"
    step_ok "Build tools (already installed)"
    return
  fi

  log LINUX "Installing build tools: $pkgs_needed"
  require_sudo "Build tools (${pkgs_needed# })" "are required for compiling native modules and need user authorization to install"
  start_spinner "Installing build tools..."

  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  log LINUX "Using package manager: $pkg_mgr"

  case "$pkg_mgr" in
    apt)    run_silent "build-tools" sudo apt-get update -qq && run_silent "build-tools" sudo apt-get install -yqq $pkgs_needed ;;
    dnf)    run_silent "build-tools" sudo dnf install -y gcc gcc-c++ make python3 ;;
    yum)    run_silent "build-tools" sudo yum install -y gcc gcc-c++ make python3 ;;
    pacman) run_silent "build-tools" sudo pacman -Sy --noconfirm base-devel python ;;
    *)      assert_fail "Cannot install build tools — unsupported package manager '${pkg_mgr}'" ;;
  esac

  log LINUX "Build tools installed"
  step_ok "Build tools installed"
}

linux::install_go() {
  log GO "Installing Go on Linux"
  linux::_find_go

  # Check if already good
  if command_exists go; then
    local go_ver go_major go_minor
    go_ver="$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/^go//')"
    go_major="$(echo "$go_ver" | cut -d. -f1)"
    go_minor="$(echo "$go_ver" | cut -d. -f2)"
    if [ "${go_major:-0}" -gt 1 ] 2>/dev/null || \
       { [ "${go_major:-0}" -eq 1 ] && [ "${go_minor:-0}" -ge 24 ]; } 2>/dev/null; then
      log GO "Already installed: v$go_ver (meets requirement)"
      step_ok "Go ${go_ver} (already installed)"
      return
    fi
    log GO "Found v$go_ver but need >= $GO_VERSION — upgrading"
  fi

  require_sudo "Go ${GO_VERSION}" "is required for building backend services and needs user authorization to install to /usr/local"
  start_spinner "Installing Go ${GO_VERSION}..."

  local arch go_arch="amd64"
  arch="$(uname -m)"
  [ "$arch" = "aarch64" ] && go_arch="arm64"
  [ "$arch" = "armv7l" ]  && go_arch="armv6l"
  log GO "Architecture: $arch -> go_arch=$go_arch"

  local go_tar="go${GO_VERSION}.linux-${go_arch}.tar.gz"
  log GO "Downloading: https://go.dev/dl/${go_tar}"

  run_silent "go-download" curl -fsSL -o "/tmp/$go_tar" "https://go.dev/dl/${go_tar}"
  assert_file "/tmp/$go_tar" "Go tarball"
  log GO "Downloaded $(wc -c < "/tmp/$go_tar") bytes"

  run_silent "go-remove-old" sudo rm -rf /usr/local/go
  run_silent "go-extract" sudo tar -C /usr/local -xzf "/tmp/$go_tar"
  rm -f "/tmp/$go_tar"
  export PATH="/usr/local/go/bin:$PATH"

  bootstrap_path
  assert_command go "-version"
  assert_command_exists gofmt
  log GO "Installed: $(go version) at $(command -v go)"
  step_ok "Go $(go version | grep -oE 'go[0-9]+\.[0-9]+\.[0-9]+')"
}

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
linux::verify_deps() {
  log VERIFY "Verifying all Linux dependencies"
  assert_command_exists curl
  assert_command_exists git
  assert_command_exists node
  assert_command_exists yarn
  assert_command go "-version"
  assert_command_exists gofmt
  assert_command_exists make
  log VERIFY "All Linux dependencies verified"
}

linux::verify_platform_binaries() {
  local rdctl_bin="resources/linux/bin/rdctl"
  local limactl_bin="resources/linux/lima/bin/limactl"
  local host_arch
  host_arch="$(uname -m)"

  log RDCTL "Verifying rdctl: $rdctl_bin (host arch: $host_arch)"
  if [ -f "$rdctl_bin" ]; then
    log RDCTL "  file info: $(file "$rdctl_bin" 2>/dev/null || echo 'unknown')"
    log RDCTL "  size: $(wc -c < "$rdctl_bin" 2>/dev/null || echo '?') bytes"
  else
    log RDCTL "  rdctl binary NOT FOUND at $rdctl_bin"
  fi
  assert_executable_runs "$rdctl_bin" "rdctl (Linux)" "version"

  log LIMA "Verifying limactl: $limactl_bin (host arch: $host_arch)"
  if [ -f "$limactl_bin" ]; then
    log LIMA "  file info: $(file "$limactl_bin" 2>/dev/null || echo 'unknown')"
    log LIMA "  size: $(wc -c < "$limactl_bin" 2>/dev/null || echo '?') bytes"
  else
    log LIMA "  limactl binary NOT FOUND at $limactl_bin"
    log LIMA "  resources/linux/lima/ contents: $(ls -la resources/linux/lima/bin/ 2>/dev/null || echo 'directory does not exist')"
  fi
  assert_executable "$limactl_bin" "limactl (Linux)"
}

# ---------------------------------------------------------------------------
# Desktop shortcut
# ---------------------------------------------------------------------------
linux::create_shortcut() {
  start_spinner "Creating application shortcut..."

  local desktop_file="$HOME/.local/share/applications/sulla-desktop.desktop"
  log SHORTCUT "Writing desktop file: $desktop_file"
  mkdir -p "$(dirname "$desktop_file")"

  cat > "$desktop_file" <<DESKTOP
[Desktop Entry]
Name=Sulla Desktop
Comment=Personal AI Assistant
Exec=bash -c 'export SULLA_PROJECT_DIR="$REPO_DIR" && cd "$REPO_DIR" && NODE_NO_WARNINGS=1 npx electron .'
Icon=$REPO_DIR/assets/logo-robot-light-nobg.png
Terminal=false
Type=Application
Categories=Utility;Development;
StartupNotify=true
DESKTOP

  command_exists update-desktop-database && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  log SHORTCUT "Desktop shortcut created"
  step_ok "Desktop shortcut created"
}

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
linux::launch_app() {
  start_spinner "Launching Sulla Desktop..."

  local log_dir
  log_dir="$(linux::get_log_dir)"
  mkdir -p "$log_dir"
  local log_file="$log_dir/launcher.log"

  log LAUNCH "REPO_DIR=$REPO_DIR"
  log LAUNCH "Log file: $log_file"
  # Check display server before launch
  log LAUNCH "DISPLAY=${DISPLAY:-not set}, WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-not set}"
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    log LAUNCH "WARN: No display server detected — Electron will likely fail"
  fi

  log LAUNCH "Spawning: npx electron ."

  SULLA_PROJECT_DIR="$REPO_DIR" NODE_NO_WARNINGS=1 nohup npx electron . >>"$log_file" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true

  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    log LAUNCH "Process started: PID $pid"
    step_ok "Sulla Desktop running (PID ${pid})"
  else
    log LAUNCH "WARN: Process $pid exited within 2 seconds"
    if [ -f "$log_file" ] && [ -s "$log_file" ]; then
      log LAUNCH "=== First 20 lines of launcher.log ==="
      head -20 "$log_file" 2>/dev/null | while IFS= read -r _line; do
        log LAUNCH "  $_line"
      done
      log LAUNCH "=== End launcher.log excerpt ==="
    else
      log LAUNCH "launcher.log is empty or missing — process may have crashed before any output"
    fi
    step_warn "Sulla Desktop may not have started — check ${log_file}"
  fi

  APP_LOG_FILE="$log_file"
}

# ---------------------------------------------------------------------------
# Pre-build hooks
# ---------------------------------------------------------------------------
linux::pre_yarn_install() {
  # Re-source nvm to ensure node is in PATH for build
  log LINUX "Pre-yarn-install: ensuring nvm/node is active for build"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    log NODE "Re-sourcing nvm from $NVM_DIR/nvm.sh before build"
    . "$NVM_DIR/nvm.sh"
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || log NODE "WARN: nvm use $NODE_VERSION failed"
  else
    log NODE "nvm.sh not found at $NVM_DIR/nvm.sh — skipping nvm sourcing"
  fi

  # Verify node is actually in PATH after sourcing
  if command_exists node; then
    log NODE "Post-source check: node=$(node -v 2>/dev/null) at $(command -v node)"
  else
    log NODE "CRITICAL: node NOT in PATH after pre_yarn_install hook"
    log NODE "NVM_DIR=$NVM_DIR, PATH=$PATH"
    assert_fail "Node.js not in PATH before build. nvm sourcing may have failed. NVM_DIR=${NVM_DIR}, PATH=${PATH}"
  fi

  # node-pty has no prebuilds for Linux — needs node-gyp to compile from source
  log LINUX "Pre-yarn-install: checking node-gyp"
  if ! command_exists node-gyp; then
    log LINUX "node-gyp not found — installing globally"
    start_spinner "Installing node-gyp (needed for native modules on Linux)..."
    run_silent "node-gyp" npm install -g node-gyp
    assert_command_exists node-gyp
    log LINUX "node-gyp installed at $(command -v node-gyp)"
    step_ok "node-gyp installed"
  else
    log LINUX "node-gyp already available at $(command -v node-gyp)"
  fi
}
