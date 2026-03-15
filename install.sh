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
MIN_DISK_GB=10
USE_NIGHTLY=false
ERROR_REPORT_URL="https://error-reports.merchantprotocol.workers.dev"

# ---------------------------------------------------------------------------
# Terminal UI — Colors & Symbols
# ---------------------------------------------------------------------------
BOLD="\033[1m"
DIM="\033[2m"
RESET="\033[0m"
GREEN="\033[1;32m"
RED="\033[1;31m"
YELLOW="\033[1;33m"
BLUE="\033[1;34m"
CYAN="\033[1;36m"
WHITE="\033[1;37m"

CHECK="${GREEN}✔${RESET}"
CROSS="${RED}✖${RESET}"
WARN_SYM="${YELLOW}⚠${RESET}"
ARROW="${BLUE}›${RESET}"

# Spinner frames
SPINNER_FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
SPINNER_PID=""

# Track all step results for final summary
STEP_RESULTS=()

# Log file for suppressed output
INSTALL_LOG="/tmp/sulla-install-$$.log"
: > "$INSTALL_LOG"

# ---------------------------------------------------------------------------
# Terminal UI — Primitives
# ---------------------------------------------------------------------------

# Hide/show cursor
hide_cursor() { printf "\033[?25l"; }
show_cursor() { printf "\033[?25h"; }

# Ensure cursor is restored on exit
cleanup() {
  stop_spinner 2>/dev/null
  show_cursor
  # Show log location if we failed
  if [ "${INSTALL_FAILED:-false}" = true ]; then
    echo ""
    printf "  ${DIM}Full log: %s${RESET}\n" "$INSTALL_LOG"
  fi
}
trap cleanup EXIT

# Clear current line
clear_line() { printf "\r\033[2K"; }

# Start a spinner with a message
# Usage: start_spinner "Doing something..."
start_spinner() {
  local msg="$1"
  stop_spinner 2>/dev/null
  (
    local i=0
    while true; do
      local frame="${SPINNER_FRAMES[$((i % ${#SPINNER_FRAMES[@]}))]}"
      printf "\r  ${CYAN}%s${RESET} %s" "$frame" "$msg"
      sleep 0.08
      i=$((i + 1))
    done
  ) &
  SPINNER_PID=$!
  disown "$SPINNER_PID" 2>/dev/null
}

# Stop the spinner
stop_spinner() {
  if [ -n "${SPINNER_PID:-}" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
    kill "$SPINNER_PID" 2>/dev/null
    wait "$SPINNER_PID" 2>/dev/null || true
  fi
  SPINNER_PID=""
  clear_line
}

# Mark a step as completed with a checkmark
step_ok() {
  stop_spinner
  printf "  ${CHECK}  %s\n" "$1"
  STEP_RESULTS+=("ok|$1")
}

# Mark a step as failed
step_fail() {
  stop_spinner
  printf "  ${CROSS}  %s\n" "$1"
  STEP_RESULTS+=("fail|$1")
  INSTALL_FAILED=true
  show_cursor

  printf "\n  ${RED}${BOLD}Installation failed.${RESET}\n"
  printf "  ${DIM}Check the log for details: %s${RESET}\n\n" "$INSTALL_LOG"

  # Offer to submit error report
  offer_error_report "$1"

  exit 1
}

# Submit an error report to the Cloudflare worker
# Usage: submit_error_report <step_name>
submit_error_report() {
  local step_name="$1"
  local log_tail=""
  if [ -f "$INSTALL_LOG" ]; then
    # JSON-escape the log: backslashes, quotes, tabs, then join lines with \n
    log_tail="$(tail -80 "$INSTALL_LOG" 2>/dev/null \
      | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' \
      | awk '{printf "%s\\n", $0}' \
      | sed 's/\\n$//')"
  fi

  local os_platform os_version app_version
  os_platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
  os_version="$(uname -r)"
  app_version="${INSTALL_REF:-unknown}"

  # Build JSON payload with printf to avoid heredoc escaping issues
  local payload
  payload=$(printf '{
  "error_type": "install_failure",
  "error_message": "Installation failed at step: %s",
  "stack_trace": "%s",
  "app_version": "%s",
  "os_platform": "%s",
  "os_version": "%s",
  "user_context": "install.sh — step: %s, nightly: %s"
}' "$step_name" "$log_tail" "$app_version" "$os_platform" "$os_version" "$step_name" "$USE_NIGHTLY")

  start_spinner "Submitting error report..."
  local http_code
  http_code="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${ERROR_REPORT_URL}/" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --max-time 10 2>/dev/null)" || http_code="000"

  if [ "$http_code" = "200" ]; then
    step_ok "Error report submitted — thank you!"
  else
    stop_spinner
    printf "  ${WARN_SYM}  Could not submit report (HTTP %s). You can report issues manually at:\n" "$http_code"
    printf "      ${DIM}https://github.com/${REPO_OWNER}/${REPO_NAME}/issues${RESET}\n"
  fi
}

# Ask user if they want to submit the error report
offer_error_report() {
  local step_name="$1"

  # If stdin is not a terminal (e.g. piped from curl), skip the prompt and auto-submit
  if [ ! -t 0 ]; then
    printf "  ${DIM}Submitting error report automatically...${RESET}\n"
    submit_error_report "$step_name"
    return
  fi

  echo ""
  printf "  ${BOLD}Would you like to submit an anonymous error report?${RESET}\n"
  printf "  ${DIM}This helps us fix installation issues faster.${RESET}\n"
  printf "  ${DIM}Only the error details and your OS info are sent — no personal data.${RESET}\n"
  echo ""
  printf "  Submit report? ${BOLD}[Y/n]${RESET} "
  local reply
  read -r reply </dev/tty 2>/dev/null || reply="y"
  reply="${reply:-y}"

  case "$reply" in
    [Nn]*)
      printf "\n  ${DIM}No problem. You can report issues manually at:${RESET}\n"
      printf "  ${DIM}https://github.com/${REPO_OWNER}/${REPO_NAME}/issues${RESET}\n"
      ;;
    *)
      echo ""
      submit_error_report "$step_name"
      ;;
  esac
}

# Mark a step with a warning
step_warn() {
  stop_spinner
  printf "  ${WARN_SYM}  %s\n" "$1"
  STEP_RESULTS+=("warn|$1")
}

# Print a section header
section() {
  echo ""
  printf "  ${WHITE}${BOLD}%s${RESET}\n" "$1"
  printf "  ${DIM}%s${RESET}\n" "$(printf '%.0s─' $(seq 1 ${#1}))"
}

# Draw a progress bar (called repeatedly)
# Usage: draw_progress <current> <total> <label>
draw_progress() {
  local current="$1" total="$2" label="${3:-}"
  local width=30
  local pct=$((current * 100 / total))
  local filled=$((current * width / total))
  local empty=$((width - filled))

  local bar=""
  [ "$filled" -gt 0 ] && bar="$(printf '%.0s█' $(seq 1 "$filled"))"
  local space=""
  [ "$empty" -gt 0 ] && space="$(printf '%.0s░' $(seq 1 "$empty"))"

  printf "\r  ${CYAN}⠸${RESET} %s ${DIM}%s%s${RESET} ${BOLD}%3d%%${RESET}" "$label" "$bar" "$space" "$pct"
}

# Run a command silently, capturing output to log
# Usage: run_silent <description> <command...>
run_silent() {
  local desc="$1"
  shift
  echo "=== [$desc] $(date) ===" >> "$INSTALL_LOG"
  echo "CMD: $*" >> "$INSTALL_LOG"
  if "$@" >> "$INSTALL_LOG" 2>&1; then
    return 0
  else
    local rc=$?
    echo "EXIT CODE: $rc" >> "$INSTALL_LOG"
    return $rc
  fi
}

# ---------------------------------------------------------------------------
# Utility helpers (unchanged logic, quiet output)
# ---------------------------------------------------------------------------
command_exists() { command -v "$1" >/dev/null 2>&1; }

detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "macos"  ;;
    Linux*)   echo "linux"  ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)        step_fail "Unsupported OS: $(uname -s)" ;;
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

get_ram_gb() {
  case "$OS" in
    macos)   sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d", $1/1073741824}' ;;
    linux)   awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo 2>/dev/null ;;
    windows)
      local kb
      kb="$(wmic OS get TotalVisibleMemorySize /value 2>/dev/null | grep -oE '[0-9]+' | head -1)" || true
      if [ -n "${kb:-}" ]; then
        echo $(( kb / 1048576 ))
      else
        echo "8"
      fi
      ;;
  esac
}

get_free_disk_gb() {
  local target="${1:-.}"
  case "$OS" in
    macos|linux)
      df -BG "$target" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}' \
        || df -k "$target" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}'
      ;;
    windows)
      df -k "$target" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}' || echo "999"
      ;;
  esac
}

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
preflight_checks() {
  section "Pre-flight Checks"

  # OS detection
  OS="$(detect_os)"
  local arch
  arch="$(uname -m)"
  step_ok "Detected ${OS} (${arch})"

  # Disk space
  start_spinner "Checking disk space..."
  local free_gb
  free_gb="$(get_free_disk_gb "$HOME")"
  if [ -n "$free_gb" ] && [ "$free_gb" -lt "$MIN_DISK_GB" ] 2>/dev/null; then
    step_fail "Not enough disk space (${free_gb} GB free, need ${MIN_DISK_GB} GB)"
  fi
  step_ok "Disk space: ${free_gb:-?} GB available"

  # Display server (Linux only)
  if [ "$OS" = "linux" ]; then
    if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
      step_warn "No display server detected — GUI may not work"
    else
      step_ok "Display server available"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Dependency installation — each is quiet with spinner
# ---------------------------------------------------------------------------
ensure_curl() {
  if command_exists curl; then
    step_ok "curl"
    return
  fi
  start_spinner "Installing curl..."
  case "$OS" in
    macos) ;; # ships with macOS
    linux)
      case "$(detect_pkg_manager)" in
        apt)    run_silent "curl" sudo apt-get update -qq && run_silent "curl" sudo apt-get install -yqq curl ;;
        dnf)    run_silent "curl" sudo dnf install -y curl ;;
        yum)    run_silent "curl" sudo yum install -y curl ;;
        pacman) run_silent "curl" sudo pacman -Sy --noconfirm curl ;;
        *)      step_fail "Cannot install curl automatically" ;;
      esac ;;
    windows) step_fail "curl not found — please install Git for Windows" ;;
  esac
  command_exists curl || step_fail "curl installation failed"
  step_ok "curl installed"
}

ensure_xcode_clt() {
  # macOS only — must run before anything that needs git or build tools
  [ "$OS" != "macos" ] && return

  # Check that CLT actually works, not just that the path is set.
  # xcode-select -p can return 0 even when tools are in a broken/stub state
  # that triggers the "install tools" GUI dialog when you run git.
  if xcode-select -p >/dev/null 2>&1 \
     && /usr/bin/xcrun --find clang >/dev/null 2>&1; then
    step_ok "Xcode Command Line Tools"
    return
  fi

  # Trigger the macOS GUI installer dialog
  xcode-select --install >/dev/null 2>&1 || true
  step_warn "User authorization needed for Xcode Command Line Tools — approve the dialog to continue"

  # Wait for the user to approve and installation to finish
  local waited=0
  while ! /usr/bin/xcrun --find clang >/dev/null 2>&1; do
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -ge 1800 ]; then
      step_fail "Xcode CLT installation timed out — please install manually and re-run"
    fi
  done

  if /usr/bin/xcrun --find clang >/dev/null 2>&1; then
    step_ok "Xcode Command Line Tools installed"
  else
    step_fail "Xcode Command Line Tools installation failed — run 'xcode-select --install' manually"
  fi
}

ensure_git() {
  if command_exists git; then
    step_ok "git ($(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'))"
    return
  fi
  start_spinner "Installing git..."
  case "$OS" in
    macos)
      # Xcode CLT should already be installed by ensure_xcode_clt
      # but if somehow git is still missing, try brew
      if command_exists brew; then
        run_silent "git" brew install git
      else
        step_fail "git not available — please install Xcode Command Line Tools and re-run"
      fi
      ;;
    linux)
      case "$(detect_pkg_manager)" in
        apt)    run_silent "git" sudo apt-get update -qq && run_silent "git" sudo apt-get install -yqq git ;;
        dnf)    run_silent "git" sudo dnf install -y git ;;
        yum)    run_silent "git" sudo yum install -y git ;;
        pacman) run_silent "git" sudo pacman -Sy --noconfirm git ;;
        *)      step_fail "Cannot install git automatically" ;;
      esac ;;
    windows) step_fail "Please install Git for Windows: https://git-scm.com/download/win" ;;
  esac
  command_exists git || step_fail "git installation failed"
  step_ok "git installed"
}

ensure_nvm() {
  if [ "$OS" = "windows" ]; then return; fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    return
  fi
  start_spinner "Installing nvm..."
  run_silent "nvm" bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  . "$NVM_DIR/nvm.sh"
  command_exists nvm || step_fail "nvm installation failed"
}

ensure_fnm() {
  if command_exists fnm; then return; fi
  start_spinner "Installing fnm..."
  if command_exists powershell.exe; then
    run_silent "fnm" powershell.exe -Command "irm https://fnm.vercel.app/install | iex" || {
      if command_exists cargo; then
        run_silent "fnm" cargo install fnm
      else
        step_fail "Cannot install fnm — please install manually"
      fi
    }
  elif command_exists cargo; then
    run_silent "fnm" cargo install fnm
  else
    step_fail "Cannot install fnm — please install manually"
  fi
  eval "$(fnm env --shell bash 2>/dev/null)" || true
  command_exists fnm || step_fail "fnm installation failed"
}

ensure_node() {
  if [ "$OS" = "windows" ]; then
    ensure_fnm
    local current=""
    command_exists node && current="$(node -v | sed 's/^v//')"
    if [ "$current" = "$NODE_VERSION" ]; then
      step_ok "Node.js v${current}"
      return
    fi
    start_spinner "Installing Node.js v${NODE_VERSION}..."
    run_silent "node" fnm install "$NODE_VERSION"
    run_silent "node" fnm use "$NODE_VERSION"
    eval "$(fnm env --shell bash 2>/dev/null)" || true
  else
    ensure_nvm
    local current=""
    command_exists node && current="$(node -v | sed 's/^v//')"
    if [ "$current" = "$NODE_VERSION" ]; then
      step_ok "Node.js v${current}"
      return
    fi
    start_spinner "Installing Node.js v${NODE_VERSION}..."
    run_silent "node" nvm install "$NODE_VERSION"
    run_silent "node" nvm use "$NODE_VERSION"
  fi
  step_ok "Node.js $(node -v)"
}

ensure_yarn() {
  if command_exists yarn; then
    step_ok "yarn ($(yarn --version))"
    return
  fi
  start_spinner "Installing yarn..."
  run_silent "yarn" bash -c 'corepack enable 2>/dev/null || npm install -g yarn'
  command_exists yarn || step_fail "yarn installation failed"
  step_ok "yarn installed"
}

ensure_build_tools() {
  case "$OS" in
    macos)
      # Already handled by ensure_xcode_clt earlier
      step_ok "Build tools (Xcode CLT)"
      ;;
    linux)
      local pkgs_needed=""
      command_exists make    || pkgs_needed="$pkgs_needed build-essential"
      command_exists python3 || pkgs_needed="$pkgs_needed python3"
      if [ -n "$pkgs_needed" ]; then
        start_spinner "Installing build tools..."
        case "$(detect_pkg_manager)" in
          apt)    run_silent "build-tools" sudo apt-get update -qq && run_silent "build-tools" sudo apt-get install -yqq $pkgs_needed ;;
          dnf)    run_silent "build-tools" sudo dnf install -y gcc gcc-c++ make python3 ;;
          yum)    run_silent "build-tools" sudo yum install -y gcc gcc-c++ make python3 ;;
          pacman) run_silent "build-tools" sudo pacman -Sy --noconfirm base-devel python ;;
          *)      step_warn "Please ensure C/C++ build tools are installed" ;;
        esac
        step_ok "Build tools installed"
      else
        step_ok "Build tools"
      fi
      ;;
    windows)
      if command_exists cl || [ -d "${PROGRAMFILES:-C:\\Program Files}/Microsoft Visual Studio" ]; then
        step_ok "Visual Studio Build Tools"
      else
        start_spinner "Installing build tools..."
        run_silent "build-tools" npm install --global windows-build-tools 2>/dev/null || true
        step_warn "VS Build Tools — install manually if native modules fail"
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
      step_ok "Go ${go_ver}"
      return
    fi
  fi

  start_spinner "Installing Go ${GO_VERSION}..."
  case "$OS" in
    macos)
      if command_exists brew; then
        run_silent "go" brew install "go@${required_major}.${required_minor}" 2>/dev/null \
          || run_silent "go" brew install go 2>/dev/null \
          || run_silent "go" brew upgrade go
        run_silent "go" brew link --overwrite "go@${required_major}.${required_minor}" 2>/dev/null || true
      else
        local arch go_arch="amd64"
        arch="$(uname -m)"
        [ "$arch" = "arm64" ] && go_arch="arm64"
        local go_pkg="go${GO_VERSION}.darwin-${go_arch}.pkg"
        run_silent "go-download" curl -fsSL -o "/tmp/$go_pkg" "https://go.dev/dl/${go_pkg}"
        run_silent "go-install" sudo installer -pkg "/tmp/$go_pkg" -target /
        rm -f "/tmp/$go_pkg"
        export PATH="/usr/local/go/bin:$PATH"
      fi
      ;;
    linux)
      local arch go_arch="amd64"
      arch="$(uname -m)"
      [ "$arch" = "aarch64" ] && go_arch="arm64"
      [ "$arch" = "armv7l" ]  && go_arch="armv6l"
      local go_tar="go${GO_VERSION}.linux-${go_arch}.tar.gz"
      run_silent "go-download" curl -fsSL -o "/tmp/$go_tar" "https://go.dev/dl/${go_tar}"
      run_silent "go-extract" sudo rm -rf /usr/local/go
      run_silent "go-extract" sudo tar -C /usr/local -xzf "/tmp/$go_tar"
      rm -f "/tmp/$go_tar"
      export PATH="/usr/local/go/bin:$PATH"
      ;;
    windows)
      local arch go_arch="amd64"
      arch="$(uname -m)"
      { [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; } && go_arch="arm64"
      local go_msi="go${GO_VERSION}.windows-${go_arch}.msi"
      run_silent "go-download" curl -fsSL -o "/tmp/$go_msi" "https://go.dev/dl/${go_msi}"
      local win_path
      win_path="$(cygpath -w "/tmp/$go_msi" 2>/dev/null || echo "/tmp/$go_msi")"
      run_silent "go-install" msiexec.exe /i "$win_path" /quiet /norestart 2>/dev/null || true
      rm -f "/tmp/$go_msi"
      export PATH="/c/Go/bin:$PATH"
      ;;
  esac

  command_exists go    || step_fail "Go installation failed"
  command_exists gofmt || step_fail "Go installation failed"
  step_ok "Go $(go version | grep -oE 'go[0-9]+\.[0-9]+\.[0-9]+')"
}

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
    step_ok "Python ($($python_cmd --version 2>/dev/null))"
  else
    step_warn "Python 3.10+ not found — training features unavailable"
  fi
}

install_dependencies() {
  section "Dependencies"
  ensure_xcode_clt
  ensure_curl
  ensure_git
  ensure_node
  ensure_yarn
  ensure_build_tools
  ensure_go
  check_python
}

# ---------------------------------------------------------------------------
# Resolve the target version
# ---------------------------------------------------------------------------
resolve_version() {
  if [ "$USE_NIGHTLY" = true ]; then
    INSTALL_REF="main"
    step_ok "Target: main (nightly)"
    return
  fi

  start_spinner "Checking for latest release..."
  local api_url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
  local release_json
  release_json="$(curl -fsSL "$api_url" 2>/dev/null)" || {
    INSTALL_REF="main"
    step_warn "Could not fetch releases — using main branch"
    return
  }

  INSTALL_REF="$(echo "$release_json" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"

  if [ -z "$INSTALL_REF" ]; then
    INSTALL_REF="main"
    step_warn "No releases found — using main branch"
    return
  fi

  step_ok "Target: ${INSTALL_REF}"
}

# ---------------------------------------------------------------------------
# Clone / update repo
# ---------------------------------------------------------------------------
checkout_version() {
  if [ "$INSTALL_REF" = "main" ]; then
    run_silent "checkout" git checkout main 2>/dev/null || true
    local stashed=false
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
      run_silent "stash" git stash --include-untracked 2>/dev/null && stashed=true
    fi
    run_silent "pull" git pull --ff-only || {
      run_silent "pull-rebase" git pull --rebase || true
    }
    if [ "$stashed" = true ]; then
      run_silent "stash-pop" git stash pop 2>/dev/null || true
    fi
  else
    local current_tag
    current_tag="$(git describe --tags --exact-match 2>/dev/null || true)"
    if [ "$current_tag" = "$INSTALL_REF" ]; then
      return
    fi
    run_silent "checkout" git checkout "$INSTALL_REF" 2>/dev/null || {
      run_silent "fetch-tag" git fetch origin "refs/tags/$INSTALL_REF:refs/tags/$INSTALL_REF" 2>/dev/null || true
      run_silent "checkout" git checkout "$INSTALL_REF" || step_fail "Failed to checkout ${INSTALL_REF}"
    }
  fi
}

ensure_repo() {
  start_spinner "Setting up repository..."

  # If we're already inside the sulla-desktop repo, use that
  if [ -f "package.json" ] && grep -q '"sulla-desktop"' package.json 2>/dev/null; then
    REPO_DIR="$(pwd)"
    checkout_version
    step_ok "Repository ready (in-place)"
    return
  fi

  local target="$HOME/$REPO_DIR"

  if [ -d "$target" ] && [ -d "$target/.git" ]; then
    cd "$target"
    run_silent "fetch" git fetch --tags --force 2>/dev/null || true
    REPO_DIR="$(pwd)"
  elif [ -d "$target" ]; then
    rm -rf "$target"
    run_silent "clone" git clone "$REPO_URL" "$target"
    cd "$target"
    REPO_DIR="$(pwd)"
  else
    run_silent "clone" git clone "$REPO_URL" "$target"
    cd "$target"
    REPO_DIR="$(pwd)"
  fi

  checkout_version
  step_ok "Repository ready (${INSTALL_REF})"
}

# ---------------------------------------------------------------------------
# Install deps & build — with progress indication
# ---------------------------------------------------------------------------
install_deps() {
  [ -f "package-lock.json" ] && rm -f package-lock.json

  if [ "$OS" = "windows" ]; then
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    fnm use "$NODE_VERSION" >/dev/null 2>&1 || true
  else
    ensure_nvm
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || true
  fi

  start_spinner "Installing dependencies (this may take a few minutes)..."
  if run_silent "yarn-install" yarn install --ignore-engines; then
    step_ok "Dependencies installed"
  else
    start_spinner "Retrying with clean state..."
    rm -rf node_modules
    if run_silent "yarn-install-retry" yarn install --ignore-engines; then
      step_ok "Dependencies installed (retry succeeded)"
    else
      step_fail "Dependency installation failed"
    fi
  fi
}

build_app() {
  if [ -d "dist" ] && [ -f "dist/app/background.js" ]; then
    step_ok "Build artifacts present (cached)"
    return
  fi

  if [ -d "dist" ]; then
    rm -rf dist
  fi

  local ram_gb
  ram_gb="$(get_ram_gb)"
  local heap_mb=8192
  if [ "${ram_gb:-0}" -le 8 ] 2>/dev/null; then
    heap_mb=4096
  elif [ "${ram_gb:-0}" -le 16 ] 2>/dev/null; then
    heap_mb=8192
  else
    heap_mb=12288
  fi

  start_spinner "Building Sulla Desktop (this may take several minutes)..."
  if run_silent "build" env NODE_OPTIONS="--max-old-space-size=$heap_mb" yarn build; then
    if [ ! -f "dist/app/background.js" ]; then
      step_fail "Build produced no output"
    fi
    step_ok "Build complete"
  else
    step_fail "Build failed — check $INSTALL_LOG for details"
  fi
}

create_shortcut() {
  start_spinner "Creating application shortcut..."
  case "$OS" in
    macos)
      local source_app="$REPO_DIR/Sulla Desktop.app"
      local desktop_app="$HOME/Desktop/Sulla Desktop.app"
      if [ ! -d "$source_app" ]; then
        step_warn "Shortcut skipped — .app bundle not found"
        return
      fi
      rm -rf "$desktop_app"
      ditto "$source_app" "$desktop_app"
      step_ok "Desktop shortcut created"
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
      command_exists update-desktop-database && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
      step_ok "Desktop shortcut created"
      ;;
    windows)
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
        " 2>/dev/null && step_ok "Desktop shortcut created" \
          || step_warn "Could not create desktop shortcut"
      else
        step_warn "Shortcut skipped — PowerShell not available"
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Launch as background daemon
# ---------------------------------------------------------------------------
launch_app() {
  start_spinner "Launching Sulla Desktop..."

  local log_dir
  log_dir="$(get_log_dir)"
  mkdir -p "$log_dir"
  local log_file="$log_dir/launcher.log"

  case "$OS" in
    macos|linux)
      NODE_NO_WARNINGS=1 nohup npx electron . >>"$log_file" 2>&1 &
      local pid=$!
      disown "$pid" 2>/dev/null || true
      # Give it a moment to ensure it started
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        step_ok "Sulla Desktop running (PID ${pid})"
      else
        step_warn "Sulla Desktop may not have started — check ${log_file}"
      fi
      ;;
    windows)
      local repo_win_path
      repo_win_path="$(cygpath -w "$REPO_DIR" 2>/dev/null || echo "$REPO_DIR")"
      local log_win_path
      log_win_path="$(cygpath -w "$log_file" 2>/dev/null || echo "$log_file")"
      cmd.exe /C "start /B cmd /C \"cd /d ${repo_win_path} && set NODE_NO_WARNINGS=1 && npx electron . >> ${log_win_path} 2>&1\"" 2>/dev/null \
        || NODE_NO_WARNINGS=1 npx electron . >>"$log_file" 2>&1 &
      step_ok "Sulla Desktop launched"
      ;;
  esac

  APP_LOG_FILE="$log_file"
}

# ---------------------------------------------------------------------------
# Final success banner
# ---------------------------------------------------------------------------
print_success() {
  local log_file="${APP_LOG_FILE:-}"

  echo ""
  echo ""
  printf "  ${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}\n"
  printf "  ${GREEN}${BOLD}║                                                          ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║   ${CHECK}  ${WHITE}Installation Complete!${GREEN}                            ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║                                                          ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║   ${RESET}${DIM}Sulla Desktop is now running in the background.${GREEN}${BOLD}      ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║   ${RESET}${DIM}You can safely close this window.${GREEN}${BOLD}                   ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║                                                          ║${RESET}\n"
  printf "  ${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}\n"
  echo ""
  if [ -n "$log_file" ]; then
    printf "  ${DIM}App logs: %s${RESET}\n" "$log_file"
  fi
  printf "  ${DIM}Install log: %s${RESET}\n" "$INSTALL_LOG"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
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

  hide_cursor
  echo ""
  printf "  ${BOLD}${WHITE}Sulla Desktop${RESET} ${DIM}— Installer${RESET}\n"
  echo ""

  # Phase 1: Pre-flight
  preflight_checks

  # Phase 2: Dependencies
  install_dependencies

  # Phase 3: Version & Repo
  section "Setup"
  resolve_version
  ensure_repo

  # Phase 4: Build
  section "Build"
  install_deps
  build_app
  create_shortcut

  # Phase 5: Launch
  section "Launch"
  launch_app

  # Done!
  show_cursor
  print_success
}

main "$@"
