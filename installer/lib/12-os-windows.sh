#!/usr/bin/env bash
# ============================================================================
# 12-os-windows.sh — Windows Platform Module
# ============================================================================
# All Windows-specific logic lives here under the windows:: namespace.
# Targets Git Bash / MSYS2 environments.
# Implements the required OS interface defined in 02-platform.sh.
# ============================================================================

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
windows::preflight() {
  log WINDOWS "Running Windows pre-flight checks"
  local arch
  arch="$(detect_arch)"
  log WINDOWS "Detected architecture: $arch"
  step_ok "Detected Windows (${arch}) — Git Bash / MSYS2"

  if [ "$arch" = "arm64" ] || [ "$arch" = "aarch64" ]; then
    export M1=true
    log WINDOWS "ARM architecture detected, setting M1=true"
  fi
  log WINDOWS "Pre-flight checks complete"
}

# ---------------------------------------------------------------------------
# System info
# ---------------------------------------------------------------------------
windows::get_ram_gb() {
  log WINDOWS "Querying system RAM via wmic"
  local kb
  kb="$(wmic OS get TotalVisibleMemorySize /value 2>/dev/null | grep -oE '[0-9]+' | head -1)" || true
  if [ -n "${kb:-}" ]; then
    local gb=$(( kb / 1048576 ))
    log WINDOWS "RAM detected: ${kb} KB = ${gb} GB"
    echo "$gb"
  else
    log WINDOWS "wmic query failed, defaulting to 8 GB"
    echo "8"
  fi
}

windows::get_free_disk_gb() {
  local target="${1:-.}"
  log WINDOWS "Querying free disk space for target: $target"
  local result
  result="$(df -k "$target" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}')" || result="999"
  log WINDOWS "Free disk space: ${result} GB"
  echo "$result"
}

windows::get_log_dir() {
  local dir="${APPDATA:-$HOME/AppData/Roaming}/Sulla Desktop/logs"
  log WINDOWS "Log directory: $dir"
  echo "$dir"
}

# ---------------------------------------------------------------------------
# Dependency audit
# ---------------------------------------------------------------------------
windows::audit_deps() {
  log DEPS "Starting Windows dependency audit"

  # curl
  if command_exists curl; then
    log DEPS "curl found at: $(command -v curl)"
    dep_found "curl"
  else
    log DEPS "curl not found"
    dep_missing "curl" "not installed"
  fi

  # git
  if command_exists git && git --version >/dev/null 2>&1; then
    local git_ver
    git_ver="$(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
    log DEPS "git found at: $(command -v git), version: $git_ver"
    dep_found "git" "$git_ver"
  else
    log DEPS "git not found or not functional"
    dep_missing "git" "not installed"
  fi

  # Node.js
  log DEPS "Sourcing node manager for Node.js check"
  windows::_source_node_manager
  local node_current=""
  command_exists node && node_current="$(node -v 2>/dev/null | sed 's/^v//')"

  if [ -n "$node_current" ] && [ "$node_current" = "$NODE_VERSION" ]; then
    log DEPS "Node.js found at: $(command -v node), version: v${node_current} (matches required v${NODE_VERSION})"
    dep_found "Node.js" "v${node_current}"
  elif [ -n "$node_current" ]; then
    log DEPS "Node.js found at: $(command -v node), version: v${node_current} (needs upgrade to v${NODE_VERSION})"
    dep_upgrade "Node.js" "v${node_current} → v${NODE_VERSION}"
  else
    log DEPS "Node.js not found, need v${NODE_VERSION}"
    dep_missing "Node.js" "need v${NODE_VERSION}"
  fi

  # yarn
  if command_exists yarn; then
    local yarn_ver
    yarn_ver="$(yarn --version 2>/dev/null)"
    log DEPS "yarn found at: $(command -v yarn), version: $yarn_ver"
    dep_found "yarn" "$yarn_ver"
  else
    log DEPS "yarn not found"
    dep_missing "yarn" "not installed"
  fi

  # Build tools
  if command_exists cl || [ -d "${PROGRAMFILES:-C:\\Program Files}/Microsoft Visual Studio" ]; then
    log DEPS "Build tools found: Visual Studio detected"
    dep_found "Build tools" "Visual Studio"
  else
    log DEPS "Build tools not found — VS Build Tools may be needed"
    dep_warn "Build tools" "VS Build Tools may be needed"
  fi

  # Go
  log DEPS "Searching for Go installation"
  windows::_find_go
  if command_exists go; then
    local go_ver go_major go_minor
    go_ver="$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/^go//')"
    go_major="$(echo "$go_ver" | cut -d. -f1)"
    go_minor="$(echo "$go_ver" | cut -d. -f2)"
    log DEPS "Go found at: $(command -v go), version: ${go_ver} (major=$go_major minor=$go_minor)"
    if [ "${go_major:-0}" -gt 1 ] 2>/dev/null || \
       { [ "${go_major:-0}" -eq 1 ] && [ "${go_minor:-0}" -ge 24 ]; } 2>/dev/null; then
      log DEPS "Go version ${go_ver} meets minimum requirement (>=1.24)"
      dep_found "Go" "${go_ver}"
    else
      log DEPS "Go version ${go_ver} below minimum, needs upgrade to ${GO_VERSION}"
      dep_upgrade "Go" "${go_ver} → ${GO_VERSION}"
    fi
  else
    log DEPS "Go not found, need ${GO_VERSION}+"
    dep_missing "Go" "need ${GO_VERSION}+"
  fi

  # Python (optional)
  log DEPS "Checking for Python"
  windows::_check_python
  log DEPS "Dependency audit complete"
}

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
windows::_source_node_manager() {
  log NODE "Sourcing node version manager"
  if command_exists fnm; then
    log NODE "fnm found at: $(command -v fnm), activating environment"
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    log NODE "Switching fnm to Node.js v${NODE_VERSION}"
    fnm use "$NODE_VERSION" >/dev/null 2>&1 || true
    log NODE "fnm environment sourced, node now at: $(command -v node 2>/dev/null || echo 'not available')"
  else
    log NODE "fnm not found, skipping node manager activation"
  fi
}

windows::_find_go() {
  log GO "Searching for Go binary on Windows"
  if ! command_exists go; then
    log GO "Go not on PATH, checking common Windows locations"
    for go_path in /c/Go/bin "/c/Program Files/Go/bin" "$HOME/go/bin"; do
      log GO "Checking: $go_path/go"
      if [ -x "$go_path/go" ]; then
        log PATH "Adding Go path to PATH: $go_path"
        export PATH="$go_path:$PATH"
        log GO "Found Go at: $go_path/go"
        break
      fi
    done
    if ! command_exists go; then
      log GO "Go not found in any common location"
    fi
  else
    log GO "Go already on PATH at: $(command -v go)"
  fi
}

windows::_check_python() {
  log DEPS "Scanning for Python 3.10+"
  local python_ver=""
  for cmd in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command_exists "$cmd"; then
      local ver minor
      ver="$($cmd --version 2>/dev/null | grep -oE '3\.[0-9]+' | head -1)" || continue
      minor="$(echo "$ver" | cut -d. -f2)"
      log DEPS "Found $cmd with version 3.${minor} at: $(command -v "$cmd")"
      if [ "${minor:-0}" -ge 10 ] 2>/dev/null; then
        python_ver="$($cmd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
        log DEPS "Python ${python_ver} meets minimum requirement (>=3.10)"
        break
      else
        log DEPS "Python 3.${minor} below minimum (3.10), skipping"
      fi
    fi
  done
  if [ -n "$python_ver" ]; then
    dep_found "Python" "${python_ver}"
  else
    log DEPS "No suitable Python found (need 3.10+)"
    dep_warn "Python" "3.10+ not found — training features unavailable"
  fi
}

# ---------------------------------------------------------------------------
# Installers
# ---------------------------------------------------------------------------
windows::install_xcode_clt() {
  # No-op on Windows
  log WINDOWS "install_xcode_clt called — no-op on Windows"
  return 0
}

windows::install_curl() {
  log DEPS "curl not found on Windows — cannot auto-install"
  assert_fail "curl not found — please install Git for Windows (includes curl): https://git-scm.com/download/win"
}

windows::install_git() {
  log GIT "git not found on Windows — cannot auto-install"
  assert_fail "git not found — please install Git for Windows: https://git-scm.com/download/win"
}

windows::install_node() {
  log NODE "Starting Node.js v${NODE_VERSION} installation for Windows"
  start_spinner "Installing Node.js v${NODE_VERSION}..."

  log NODE "Ensuring fnm is installed"
  windows::_install_fnm

  log NODE "Installing Node.js v${NODE_VERSION} via fnm"
  run_silent "node-install" fnm install "$NODE_VERSION"
  log NODE "Switching to Node.js v${NODE_VERSION} via fnm"
  run_silent "node-use" fnm use "$NODE_VERSION"
  log NODE "Re-sourcing fnm environment"
  eval "$(fnm env --shell bash 2>/dev/null)" || true

  assert_command_exists node
  local installed_ver
  installed_ver="$(node -v 2>/dev/null | sed 's/^v//')"
  log NODE "Node.js installed at: $(command -v node), version: v${installed_ver}"
  if [ "$installed_ver" != "$NODE_VERSION" ]; then
    log NODE "FAILURE: Version mismatch — expected v${NODE_VERSION}, got v${installed_ver}"
    assert_fail "Node.js version mismatch: expected v${NODE_VERSION}, got v${installed_ver}"
  fi
  log NODE "Node.js v${installed_ver} installation successful"
  step_ok "Node.js v${installed_ver}"
}

windows::_install_fnm() {
  log NODE "Checking if fnm is already installed"
  if command_exists fnm; then
    log NODE "fnm already available at: $(command -v fnm)"
    return
  fi

  log NODE "fnm not found, attempting installation"

  _fnm_via_powershell() {
    log NODE "Attempting fnm install via PowerShell"
    command_exists powershell.exe && \
      run_silent "fnm" powershell.exe -Command "irm https://fnm.vercel.app/install | iex"
  }
  _fnm_via_cargo() {
    log NODE "Attempting fnm install via Cargo"
    command_exists cargo && run_silent "fnm" cargo install fnm
  }

  if command_exists powershell.exe; then
    log NODE "PowerShell available at: $(command -v powershell.exe), trying PowerShell install with Cargo fallback"
    try_with_fallback "fnm via PowerShell" _fnm_via_powershell -- _fnm_via_cargo
  elif command_exists cargo; then
    log NODE "Cargo available at: $(command -v cargo), installing fnm via Cargo"
    run_silent "fnm" cargo install fnm
  else
    log NODE "FAILURE: Neither PowerShell nor Cargo available for fnm installation"
    assert_fail "Cannot install fnm — neither PowerShell nor Cargo available. Install fnm manually: https://github.com/Schniz/fnm"
  fi

  log NODE "Sourcing fnm environment after installation"
  eval "$(fnm env --shell bash 2>/dev/null)" || true
  assert_command_exists fnm
  log NODE "fnm installed successfully at: $(command -v fnm)"
}

windows::install_yarn() {
  log YARN "Starting yarn installation for Windows"
  start_spinner "Installing yarn..."
  log YARN "Attempting corepack enable, falling back to npm install -g yarn"
  run_silent "yarn" bash -c 'corepack enable 2>/dev/null || npm install -g yarn'
  assert_command_exists yarn
  local yarn_ver
  yarn_ver="$(yarn --version)"
  log YARN "yarn installed at: $(command -v yarn), version: $yarn_ver"
  step_ok "yarn ${yarn_ver}"
}

windows::install_build_tools() {
  log BUILD "Starting Visual Studio Build Tools check/install for Windows"
  # Best effort — npm windows-build-tools or warn
  start_spinner "Checking Visual Studio Build Tools..."
  log BUILD "Attempting: npm install --global windows-build-tools"
  run_silent "build-tools" npm install --global windows-build-tools 2>/dev/null || true
  log BUILD "windows-build-tools install attempted (may have failed — best effort)"
  step_warn "VS Build Tools — install manually if native modules fail: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
}

windows::install_go() {
  log GO "Starting Go installation for Windows"
  windows::_find_go

  # Check if already good
  if command_exists go; then
    local go_ver go_major go_minor
    go_ver="$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/^go//')"
    go_major="$(echo "$go_ver" | cut -d. -f1)"
    go_minor="$(echo "$go_ver" | cut -d. -f2)"
    log GO "Existing Go found: ${go_ver} (major=$go_major minor=$go_minor)"
    if [ "${go_major:-0}" -gt 1 ] 2>/dev/null || \
       { [ "${go_major:-0}" -eq 1 ] && [ "${go_minor:-0}" -ge 24 ]; } 2>/dev/null; then
      log GO "Go ${go_ver} meets minimum requirement (>=1.24), skipping install"
      step_ok "Go ${go_ver} (already installed)"
      return
    fi
    log GO "Go ${go_ver} below minimum (1.24), proceeding with upgrade"
  else
    log GO "No existing Go found, proceeding with fresh install"
  fi

  start_spinner "Installing Go ${GO_VERSION}..."

  local arch go_arch="amd64"
  arch="$(uname -m)"
  { [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; } && go_arch="arm64"
  log GO "System architecture: $arch, Go architecture: $go_arch"

  local go_msi="go${GO_VERSION}.windows-${go_arch}.msi"
  local url="https://go.dev/dl/${go_msi}"
  log GO "Downloading Go from: $url"
  run_silent "go-download" curl -fsSL -o "/tmp/$go_msi" "$url"
  assert_file "/tmp/$go_msi" "Go MSI installer"
  log GO "MSI downloaded to: /tmp/$go_msi"

  local win_path
  win_path="$(cygpath -w "/tmp/$go_msi" 2>/dev/null || echo "/tmp/$go_msi")"
  log GO "Running MSI installer: msiexec.exe /i $win_path /quiet /norestart"
  run_silent "go-install" msiexec.exe /i "$win_path" /quiet /norestart
  log GO "MSI installer completed, cleaning up"
  rm -f "/tmp/$go_msi"
  log PATH "Adding /c/Go/bin to PATH"
  export PATH="/c/Go/bin:$PATH"

  log GO "Running bootstrap_path to refresh PATH"
  bootstrap_path
  assert_command go "-version"
  assert_command_exists gofmt
  local final_ver
  final_ver="$(go version | grep -oE 'go[0-9]+\.[0-9]+\.[0-9]+')"
  log GO "Go installed at: $(command -v go), version: $final_ver"
  log GO "gofmt installed at: $(command -v gofmt)"
  step_ok "Go ${final_ver}"
}

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
windows::verify_deps() {
  log VERIFY "Verifying all required dependencies for Windows"
  log VERIFY "Checking curl at: $(command -v curl 2>/dev/null || echo 'NOT FOUND')"
  assert_command_exists curl
  log VERIFY "Checking git at: $(command -v git 2>/dev/null || echo 'NOT FOUND')"
  assert_command_exists git
  log VERIFY "Checking node at: $(command -v node 2>/dev/null || echo 'NOT FOUND')"
  assert_command_exists node
  log VERIFY "Checking yarn at: $(command -v yarn 2>/dev/null || echo 'NOT FOUND')"
  assert_command_exists yarn
  log VERIFY "Checking go at: $(command -v go 2>/dev/null || echo 'NOT FOUND')"
  assert_command go "-version"
  log VERIFY "Checking gofmt at: $(command -v gofmt 2>/dev/null || echo 'NOT FOUND')"
  assert_command_exists gofmt
  log VERIFY "All required dependencies verified"
}

windows::verify_platform_binaries() {
  log VERIFY "Verifying Windows platform binaries"
  local rdctl_bin="resources/win32/bin/rdctl.exe"
  log VERIFY "Checking rdctl binary: $rdctl_bin"
  assert_executable_runs "$rdctl_bin" "rdctl (Windows)" "version"
  log VERIFY "rdctl binary verified successfully"
  # No limactl on Windows (uses WSL instead)
  log VERIFY "Skipping limactl check (Windows uses WSL)"
}

# ---------------------------------------------------------------------------
# Desktop shortcut
# ---------------------------------------------------------------------------
windows::create_shortcut() {
  log SHORTCUT "Creating Windows desktop shortcut"
  start_spinner "Creating application shortcut..."

  local desktop_path
  desktop_path="$(cmd.exe /C 'echo %USERPROFILE%\Desktop' 2>/dev/null | tr -d '\r')" \
    || desktop_path="$HOME/Desktop"
  log SHORTCUT "Desktop path: $desktop_path"

  local repo_win_path
  repo_win_path="$(cygpath -w "$REPO_DIR" 2>/dev/null || echo "$REPO_DIR")"
  log SHORTCUT "Repo Windows path: $repo_win_path"

  if command_exists powershell.exe; then
    log SHORTCUT "PowerShell available, creating .lnk shortcut via WScript.Shell"
    powershell.exe -NoProfile -Command "
      \$ws = New-Object -ComObject WScript.Shell;
      \$sc = \$ws.CreateShortcut('${desktop_path}\\Sulla Desktop.lnk');
      \$sc.TargetPath = 'cmd.exe';
      \$sc.Arguments = '/c cd /d \"${repo_win_path}\" && set SULLA_PROJECT_DIR=${repo_win_path} && npx electron .';
      \$sc.WorkingDirectory = '${repo_win_path}';
      \$sc.Description = 'Sulla Desktop — Personal AI Assistant';
      \$sc.Save()
    " 2>/dev/null && {
      log SHORTCUT "Desktop shortcut created successfully at: ${desktop_path}\\Sulla Desktop.lnk"
      step_ok "Desktop shortcut created"
    } || {
      log SHORTCUT "FAILURE: PowerShell shortcut creation failed"
      step_warn "Could not create desktop shortcut"
    }
  else
    log SHORTCUT "PowerShell not available, skipping shortcut creation"
    step_warn "Shortcut skipped — PowerShell not available"
  fi
}

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
windows::launch_app() {
  log LAUNCH "Launching Sulla Desktop on Windows"
  start_spinner "Launching Sulla Desktop..."

  local log_dir
  log_dir="$(windows::get_log_dir)"
  mkdir -p "$log_dir"
  local log_file="$log_dir/launcher.log"
  log LAUNCH "Launcher log file: $log_file"

  local repo_win_path
  repo_win_path="$(cygpath -w "$REPO_DIR" 2>/dev/null || echo "$REPO_DIR")"
  log LAUNCH "Repo Windows path: $repo_win_path"
  local log_win_path
  log_win_path="$(cygpath -w "$log_file" 2>/dev/null || echo "$log_file")"
  log LAUNCH "Log Windows path: $log_win_path"

  log LAUNCH "Attempting launch via cmd.exe start /B"
  cmd.exe /C "start /B cmd /C \"cd /d ${repo_win_path} && set NODE_NO_WARNINGS=1 && set SULLA_PROJECT_DIR=${repo_win_path} && npx electron . >> ${log_win_path} 2>&1\"" 2>/dev/null \
    || {
      log LAUNCH "cmd.exe launch failed, falling back to direct npx electron"
      SULLA_PROJECT_DIR="$REPO_DIR" NODE_NO_WARNINGS=1 npx electron . >>"$log_file" 2>&1 &
    }

  log LAUNCH "Sulla Desktop launched successfully"
  step_ok "Sulla Desktop launched"
  APP_LOG_FILE="$log_file"
  log LAUNCH "APP_LOG_FILE set to: $log_file"
}

# ---------------------------------------------------------------------------
# Pre-build hooks
# ---------------------------------------------------------------------------
windows::pre_yarn_install() {
  log NODE "Running Windows pre-yarn-install hook"
  # Activate fnm before yarn install
  if command_exists fnm; then
    log NODE "fnm found at: $(command -v fnm), activating environment"
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    log NODE "Switching to Node.js v${NODE_VERSION} via fnm"
    fnm use "$NODE_VERSION" >/dev/null 2>&1 || true
    log NODE "Node now at: $(command -v node 2>/dev/null || echo 'not available')"
  else
    log NODE "fnm not found, skipping pre-yarn-install activation"
  fi
  log NODE "Pre-yarn-install hook complete"
}
