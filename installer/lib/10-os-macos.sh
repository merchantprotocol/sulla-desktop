#!/usr/bin/env bash
# ============================================================================
# 10-os-macos.sh — macOS Platform Module
# ============================================================================
# All macOS-specific logic lives here under the macos:: namespace.
# Implements the required OS interface defined in 02-platform.sh.
# All actions logged with [MACOS] tag.
# ============================================================================

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
macos::preflight() {
  local arch
  arch="$(detect_arch)"
  log MACOS "Preflight: arch=$arch kernel=$(uname -r)"
  step_ok "Detected macOS (${arch})"

  # Export M1 flag for postinstall scripts (rdctl Go cross-compilation)
  if [ "$arch" = "arm64" ] || [ "$arch" = "aarch64" ]; then
    export M1=true
    log MACOS "ARM architecture detected — exported M1=true"
  else
    log MACOS "x86_64 architecture — M1 not set"
  fi
}

# ---------------------------------------------------------------------------
# System info
# ---------------------------------------------------------------------------
macos::get_ram_gb() {
  sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d", $1/1073741824}'
}

macos::get_free_disk_gb() {
  local target="${1:-.}"
  df -BG "$target" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}' \
    || df -k "$target" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}'
}

macos::get_log_dir() {
  echo "$HOME/Library/Logs/Sulla Desktop"
}

# ---------------------------------------------------------------------------
# Dependency audit — check everything without installing
# ---------------------------------------------------------------------------
macos::audit_deps() {
  log MACOS "Starting dependency audit"

  # Xcode CLT
  log XCODE "Checking Xcode CLT: xcode-select -p && xcrun --find clang"
  if xcode-select -p >/dev/null 2>&1 \
     && /usr/bin/xcrun --find clang >/dev/null 2>&1; then
    dep_found "Xcode CLT"
    local xcode_ok=true
    log XCODE "Xcode CLT: installed and functional"
  else
    dep_missing "Xcode CLT" "not installed"
    local xcode_ok=false
    log XCODE "Xcode CLT: NOT installed or stub state"
  fi

  # curl (always present on macOS, but check anyway)
  if command_exists curl; then
    dep_found "curl"
    log MACOS "curl: found at $(command -v curl)"
  else
    dep_missing "curl" "not installed"
    log MACOS "curl: NOT found"
  fi

  # git — on macOS without CLT, git is a shim that pops the install dialog
  if [ "$xcode_ok" = false ]; then
    dep_missing "git" "provided by Xcode CLT"
    log GIT "git: skipped (Xcode CLT not installed, git would trigger dialog)"
  elif command_exists git && git --version >/dev/null 2>&1; then
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
  macos::_source_node_manager
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
    local yarn_ver
    yarn_ver="$(yarn --version 2>/dev/null)"
    dep_found "yarn" "$yarn_ver"
    log YARN "yarn: found v$yarn_ver at $(command -v yarn)"
  else
    dep_missing "yarn" "not installed"
    log YARN "yarn: NOT found"
  fi

  # Go
  log GO "Searching for Go..."
  macos::_find_go
  if command_exists go; then
    local go_ver go_major go_minor
    go_ver="$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/^go//')"
    go_major="$(echo "$go_ver" | cut -d. -f1)"
    go_minor="$(echo "$go_ver" | cut -d. -f2)"
    log GO "Go: found v$go_ver at $(command -v go) (major=$go_major minor=$go_minor)"
    if [ "${go_major:-0}" -gt 1 ] 2>/dev/null || \
       { [ "${go_major:-0}" -eq 1 ] && [ "${go_minor:-0}" -ge 24 ]; } 2>/dev/null; then
      dep_found "Go" "${go_ver}"
    else
      dep_upgrade "Go" "${go_ver} → ${GO_VERSION}"
    fi
  else
    dep_missing "Go" "need ${GO_VERSION}+"
    log GO "Go: NOT found in any known location"
  fi

  # Python (optional — warn only)
  macos::_check_python

  log MACOS "Dependency audit complete"
}

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
macos::_source_node_manager() {
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

macos::_find_go() {
  if ! command_exists go; then
    for go_path in /opt/homebrew/bin /usr/local/bin /usr/local/go/bin "$HOME/go/bin"; do
      if [ -x "$go_path/go" ]; then
        log GO "Found go at $go_path/go — adding to PATH"
        export PATH="$go_path:$PATH"
        break
      fi
    done
  fi
}

macos::_check_python() {
  local python_ver=""
  for cmd in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command_exists "$cmd"; then
      local ver minor
      ver="$($cmd --version 2>/dev/null | grep -oE '3\.[0-9]+' | head -1)" || continue
      minor="$(echo "$ver" | cut -d. -f2)"
      if [ "${minor:-0}" -ge 10 ] 2>/dev/null; then
        python_ver="$($cmd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
        log MACOS "Python: found v$python_ver via $cmd"
        break
      fi
    fi
  done
  if [ -n "$python_ver" ]; then
    dep_found "Python" "${python_ver}"
  else
    dep_warn "Python" "3.10+ not found — training features unavailable"
    log MACOS "Python: 3.10+ NOT found"
  fi
}

# ---------------------------------------------------------------------------
# Installers
# ---------------------------------------------------------------------------
macos::install_xcode_clt() {
  log XCODE "Installing Xcode Command Line Tools"

  # Recheck — may have been installed between audit and now
  if xcode-select -p >/dev/null 2>&1 \
     && /usr/bin/xcrun --find clang >/dev/null 2>&1; then
    log XCODE "Already installed (recheck passed)"
    step_ok "Xcode Command Line Tools"
    return
  fi

  log XCODE "Triggering xcode-select --install dialog"
  xcode-select --install >/dev/null 2>&1 || true
  step_warn "User authorization needed for Xcode Command Line Tools — approve the dialog to continue"

  local waited=0
  while ! /usr/bin/xcrun --find clang >/dev/null 2>&1; do
    sleep 5
    waited=$((waited + 5))
    log XCODE "Waiting for Xcode CLT install... ${waited}s elapsed"
    if [ "$waited" -ge 1800 ]; then
      assert_fail "Xcode CLT installation timed out after 30 minutes — please install manually and re-run"
    fi
  done
  log XCODE "Xcode CLT installation confirmed"
  step_ok "Xcode Command Line Tools installed"
}

macos::install_curl() {
  log MACOS "Checking curl availability"
  if command_exists curl; then
    step_ok "curl (pre-installed)"
    return
  fi
  assert_fail "curl not found on macOS — this should never happen. Is your system corrupt?"
}

macos::install_git() {
  log GIT "Installing git on macOS"

  # Recheck — CLT may have just been installed
  if command_exists git && git --version >/dev/null 2>&1; then
    log GIT "Already available: $(git --version)"
    step_ok "git $(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
    return
  fi

  if command_exists brew; then
    log GIT "Installing via Homebrew"
    start_spinner "Installing git via Homebrew..."
    run_silent "git" brew install git
    command_exists git || assert_fail "git installation via Homebrew failed"
    log GIT "Installed: $(git --version)"
    step_ok "git installed via Homebrew"
  else
    assert_fail "git not available — Xcode CLT installation may have failed. Install Xcode CLT or Homebrew and re-run."
  fi
}

macos::install_node() {
  log NODE "Installing Node.js v${NODE_VERSION} on macOS"
  start_spinner "Installing Node.js v${NODE_VERSION}..."

  macos::_install_nvm

  log NODE "Running: nvm install $NODE_VERSION"
  run_silent "node-install" nvm install "$NODE_VERSION"
  run_silent "node-use" nvm use "$NODE_VERSION"

  assert_command_exists node
  local installed_ver
  installed_ver="$(node -v 2>/dev/null | sed 's/^v//')"
  log NODE "Installed: v$installed_ver (expected: v$NODE_VERSION)"
  if [ "$installed_ver" != "$NODE_VERSION" ]; then
    assert_fail "Node.js version mismatch: expected v${NODE_VERSION}, got v${installed_ver}"
  fi
  log NODE "node binary: $(command -v node)"
  step_ok "Node.js v${installed_ver}"
}

macos::_install_nvm() {
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

macos::install_yarn() {
  log YARN "Installing yarn on macOS"
  start_spinner "Installing yarn..."
  run_silent "yarn" bash -c 'corepack enable 2>/dev/null || npm install -g yarn'
  assert_command_exists yarn
  log YARN "Installed: v$(yarn --version) at $(command -v yarn)"
  step_ok "yarn $(yarn --version)"
}

macos::install_build_tools() {
  log MACOS "Build tools: provided by Xcode CLT on macOS"
  step_ok "Build tools (provided by Xcode CLT)"
}

macos::install_go() {
  log GO "Installing Go on macOS"
  macos::_find_go

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

  if command_exists brew; then
    log GO "Installing via Homebrew"
    start_spinner "Installing Go ${GO_VERSION} via Homebrew..."

    _macos_go_brew_primary() {
      run_silent "go" brew install "go@1.24" 2>/dev/null \
        && run_silent "go-link" brew link --overwrite "go@1.24" 2>/dev/null
    }
    _macos_go_brew_fallback() {
      run_silent "go" brew install go \
        || run_silent "go" brew upgrade go
    }

    try_with_fallback "Go via Homebrew (go@1.24)" _macos_go_brew_primary -- _macos_go_brew_fallback
  else
    log GO "Homebrew not available — using .pkg installer"
    require_sudo "Go ${GO_VERSION}" "needs to install to /usr/local"
    start_spinner "Installing Go ${GO_VERSION} via .pkg..."

    local go_arch="amd64"
    [ "$(uname -m)" = "arm64" ] && go_arch="arm64"
    local go_pkg="go${GO_VERSION}.darwin-${go_arch}.pkg"
    log GO "Downloading: https://go.dev/dl/${go_pkg}"

    run_silent "go-download" curl -fsSL -o "/tmp/$go_pkg" "https://go.dev/dl/${go_pkg}"
    assert_file "/tmp/$go_pkg" "Go installer package"
    log GO "Downloaded $(wc -c < "/tmp/$go_pkg") bytes"

    run_silent "go-install" sudo installer -pkg "/tmp/$go_pkg" -target /
    rm -f "/tmp/$go_pkg"
    export PATH="/usr/local/go/bin:$PATH"
  fi

  bootstrap_path
  assert_command go "-version"
  assert_command_exists gofmt
  log GO "Installed: $(go version) at $(command -v go)"
  log GO "gofmt at: $(command -v gofmt)"
  step_ok "Go $(go version | grep -oE 'go[0-9]+\.[0-9]+\.[0-9]+')"
}

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
macos::verify_deps() {
  log VERIFY "Verifying all macOS dependencies"
  assert_command_exists curl
  assert_command_exists git
  assert_command_exists node
  assert_command_exists yarn
  assert_command go "-version"
  assert_command_exists gofmt

  # Verify Xcode CLT
  log XCODE "Verifying Xcode CLT is functional"
  if ! /usr/bin/xcrun --find clang >/dev/null 2>&1; then
    assert_fail "Xcode Command Line Tools not functional after installation"
  fi
  log VERIFY "All macOS dependencies verified"
}

macos::verify_platform_binaries() {
  local rdctl_bin="resources/darwin/bin/rdctl"
  local limactl_bin="resources/darwin/lima/bin/limactl"
  local host_arch
  host_arch="$(uname -m)"

  log RDCTL "Verifying rdctl: $rdctl_bin (host arch: $host_arch)"
  if [ -f "$rdctl_bin" ]; then
    log RDCTL "  file info: $(file "$rdctl_bin" 2>/dev/null || echo 'unknown')"
    log RDCTL "  size: $(wc -c < "$rdctl_bin" 2>/dev/null || echo '?') bytes"
    log RDCTL "  M1 env was: ${M1:-not set}"
  else
    log RDCTL "  rdctl binary NOT FOUND at $rdctl_bin"
  fi
  assert_executable_runs "$rdctl_bin" "rdctl (macOS)" "version"

  log LIMA "Verifying limactl: $limactl_bin (host arch: $host_arch)"
  if [ -f "$limactl_bin" ]; then
    log LIMA "  file info: $(file "$limactl_bin" 2>/dev/null || echo 'unknown')"
    log LIMA "  size: $(wc -c < "$limactl_bin" 2>/dev/null || echo '?') bytes"
  else
    log LIMA "  limactl binary NOT FOUND at $limactl_bin"
    log LIMA "  resources/darwin/lima/ contents: $(ls -la resources/darwin/lima/bin/ 2>/dev/null || echo 'directory does not exist')"
  fi
  assert_executable "$limactl_bin" "limactl (macOS)"
}

# ---------------------------------------------------------------------------
# Desktop shortcut
# ---------------------------------------------------------------------------
macos::create_shortcut() {
  start_spinner "Creating application shortcut..."
  local source_app="$REPO_DIR/Sulla Desktop.app"
  local desktop_app="$HOME/Desktop/Sulla Desktop.app"

  log SHORTCUT "Source: $source_app"
  log SHORTCUT "Destination: $desktop_app"

  if [ ! -d "$source_app" ]; then
    log SHORTCUT "Source .app bundle not found — skipping"
    step_warn "Shortcut skipped — .app bundle not found at ${source_app}"
    return
  fi

  rm -rf "$desktop_app"
  ditto "$source_app" "$desktop_app"
  log SHORTCUT "Shortcut created via ditto"
  step_ok "Desktop shortcut created"
}

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
macos::launch_app() {
  start_spinner "Launching Sulla Desktop..."

  local log_dir
  log_dir="$(macos::get_log_dir)"
  mkdir -p "$log_dir"
  local log_file="$log_dir/launcher.log"

  log LAUNCH "REPO_DIR=$REPO_DIR"
  log LAUNCH "Log file: $log_file"
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
    # Capture the reason from the launcher log
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
macos::pre_yarn_install() {
  log MACOS "Pre-yarn-install hook: ensuring nvm/node is active for build"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    log NODE "Re-sourcing nvm from $NVM_DIR/nvm.sh before build"
    . "$NVM_DIR/nvm.sh"
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || log NODE "WARN: nvm use $NODE_VERSION failed"
  else
    log NODE "nvm.sh not found at $NVM_DIR/nvm.sh — skipping nvm sourcing"
  fi

  # Verify node is actually in PATH after sourcing — this catches the silent failure
  if command_exists node; then
    log NODE "Post-source check: node=$(node -v 2>/dev/null) at $(command -v node)"
  else
    log NODE "CRITICAL: node NOT in PATH after pre_yarn_install hook"
    log NODE "NVM_DIR=$NVM_DIR"
    log NODE "PATH=$PATH"
    log NODE "nvm.sh exists: $([ -s "${NVM_DIR}/nvm.sh" ] && echo yes || echo no)"
    assert_fail "Node.js not in PATH before build. nvm sourcing may have failed. NVM_DIR=${NVM_DIR}, PATH=${PATH}"
  fi
}
