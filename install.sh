#!/usr/bin/env bash
# ============================================================================
# Sulla Desktop — One-Line Installer
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
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
REPO_URL="https://github.com/merchantprotocol/sulla-desktop.git"
REPO_OWNER="merchantprotocol"
REPO_NAME="sulla-desktop"
REPO_DIR="sulla-desktop"
INSTALL_DIR="$HOME/.sulla-desktop"
NODE_VERSION="22.22.0"
GO_VERSION="1.24.2"
MIN_DISK_GB=10
USE_NIGHTLY=false
ERROR_REPORT_URL="https://error-reports.merchantprotocol.workers.dev"

# ---------------------------------------------------------------------------
# PATH Bootstrap — ensure common binary locations are reachable on all platforms
# ---------------------------------------------------------------------------
# Many tools (Go, Node, yarn, gofmt, git) may be installed in paths that are
# not in the default PATH for non-interactive shells (e.g. when piped from
# curl).  We add all well-known locations up front so every subsequent
# command_exists check and subprocess (including Node/yarn postinstall scripts)
# can find them without per-tool PATH hacks.
bootstrap_path() {
  local candidates=(
    # macOS Homebrew — Apple Silicon
    /opt/homebrew/bin
    /opt/homebrew/sbin
    # macOS Homebrew — Intel
    /usr/local/bin
    /usr/local/sbin
    # Linux Homebrew (Linuxbrew)
    /home/linuxbrew/.linuxbrew/bin
    /home/linuxbrew/.linuxbrew/sbin
    # Go — official installer location
    /usr/local/go/bin
    # Go — user GOPATH/bin
    "$HOME/go/bin"
    # Windows (Git Bash / MSYS2)
    /c/Go/bin
    /c/Program\ Files/Go/bin
    # Cargo / Rust (fnm, other tools)
    "$HOME/.cargo/bin"
    # Common Linux paths that may be missing in minimal environments
    /usr/bin
    /usr/sbin
    /bin
    /sbin
  )

  for dir in "${candidates[@]}"; do
    # Skip if already in PATH or doesn't exist
    case ":$PATH:" in
      *":$dir:"*) continue ;;
    esac
    [ -d "$dir" ] && export PATH="$dir:$PATH"
  done
}
bootstrap_path

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

# Log file for suppressed output — fixed path so it's always easy to find
INSTALL_LOG="/tmp/sulla-install.log"
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

# Run a command with live status updates — logs everything and updates the
# spinner text with the last meaningful line of output so the user can see
# what's happening during long-running operations.
# Usage: run_with_status <label> <command...>
run_with_status() {
  local label="$1"
  shift
  echo "=== [$label] $(date) ===" >> "$INSTALL_LOG"
  echo "CMD: $*" >> "$INSTALL_LOG"

  local last_update=0

  local current_phase="$label"

  # Run the command in background, writing output to a temp file.
  # We poll the file for new lines to update the spinner and use `wait`
  # on the PID to detect completion.  This avoids the pipe-fd inheritance
  # problem entirely: yarn/webpack child processes that outlive the main
  # command can hold a pipe fd open forever, but they can't prevent
  # `wait` from returning once the direct child exits.
  local rws_tmpfile
  rws_tmpfile="$(mktemp "${TMPDIR:-/tmp}/rws_output.XXXXXX")"

  "$@" > "$rws_tmpfile" 2>&1 &
  local cmd_pid=$!

  local last_update=0
  local bytes_read=0

  # Poll: check if the process is still running, tail new output
  while kill -0 "$cmd_pid" 2>/dev/null; do
    # Flush new output to the install log
    local new_output
    new_output="$(tail -c +$((bytes_read + 1)) "$rws_tmpfile" 2>/dev/null)"
    if [ -n "$new_output" ]; then
      echo "$new_output" >> "$INSTALL_LOG"
      bytes_read="$(wc -c < "$rws_tmpfile")"

      # Update spinner phase from the latest line
      local last_line
      last_line="$(echo "$new_output" | tail -1)"

      local now="$SECONDS"
      if [ "$((now - last_update))" -ge 3 ]; then
        local new_phase=""
        case "$last_line" in
          *"Resolving"*)  new_phase="${label}: resolving dependencies..." ;;
          *"Fetching"*)   new_phase="${label}: fetching packages..." ;;
          *"Linking"*)    new_phase="${label}: linking packages..." ;;
          *"Building"*)   new_phase="${label}: building..." ;;
          *"Downloading"*)
                          new_phase="${label}: downloading dependencies..." ;;
          *"gyp"*|*"node-pre-gyp"*|*"prebuild"*|*"compiling"*|*"CC("*|*"CXX("*)
                          new_phase="${label}: compiling native modules..." ;;
          *"HTTP 429"*|*"HTTP 403"*|*"rate limit"*)
                          new_phase="${label}: rate-limited by GitHub, retrying..." ;;
          *"Network error fetching"*)
                          new_phase="${label}: network error, retrying..." ;;
          *"webpack"*|*"ts-loader"*|*"babel"*)
                          new_phase="${label}: bundling application..." ;;
          *"Done in "*)
                          new_phase="${label}: finishing up..." ;;
        esac

        if [ -n "$new_phase" ] && [ "$new_phase" != "$current_phase" ]; then
          current_phase="$new_phase"
          stop_spinner 2>/dev/null
          start_spinner "$current_phase"
          last_update="$now"
        fi
      fi
    fi

    sleep 2
  done

  # Process exited — collect exit code and flush remaining output
  wait "$cmd_pid" 2>/dev/null
  local rc=$?

  local remaining
  remaining="$(tail -c +$((bytes_read + 1)) "$rws_tmpfile" 2>/dev/null)"
  [ -n "$remaining" ] && echo "$remaining" >> "$INSTALL_LOG"

  rm -f "$rws_tmpfile"

  stop_spinner 2>/dev/null
  if [ "$rc" -ne 0 ]; then
    echo "EXIT CODE: $rc" >> "$INSTALL_LOG"
  fi
  return "$rc"
}


# Prompt the user for sudo access with a clear explanation of why.
# Pre-authenticates so subsequent sudo calls don't re-prompt.
# Usage: require_sudo "Go ${GO_VERSION}" "needs to install to /usr/local which requires user authorization"
require_sudo() {
  local package="$1"
  local reason="$2"
  # Already authenticated — nothing to do
  if sudo -n true 2>/dev/null; then
    return 0
  fi
  stop_spinner
  echo ""
  printf "  ${ARROW}  ${BOLD}%s${RESET} %s\n" "$package" "$reason"
  printf "     ${DIM}Enter your password to continue:${RESET}\n"
  echo ""
  # Let sudo prompt naturally on the terminal (not swallowed by run_silent)
  if sudo -v 2>/dev/null; then
    echo ""
    return 0
  else
    step_fail "sudo authentication failed — cannot continue without user authorization"
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

  # Export M1 flag so postinstall scripts compile Go binaries for the correct
  # architecture.  Without this, rdctl is built as amd64 on Apple Silicon and
  # fails at runtime with EBADARCH (-86).
  if [ "$arch" = "arm64" ] || [ "$arch" = "aarch64" ]; then
    export M1=true
  fi

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
# Dependency management — audit everything first, then install what's needed
# ---------------------------------------------------------------------------

# Audit tracking
DEP_NAMES=()
DEP_STATUSES=()   # ok, install, upgrade, warn
DEP_DETAILS=()
DEP_WORK_NEEDED=false

dep_found()   { DEP_NAMES+=("$1"); DEP_STATUSES+=("ok");      DEP_DETAILS+=("${2:-}"); }
dep_missing() { DEP_NAMES+=("$1"); DEP_STATUSES+=("install");  DEP_DETAILS+=("$2");     DEP_WORK_NEEDED=true; }
dep_upgrade() { DEP_NAMES+=("$1"); DEP_STATUSES+=("upgrade");  DEP_DETAILS+=("$2");     DEP_WORK_NEEDED=true; }
dep_warn()    { DEP_NAMES+=("$1"); DEP_STATUSES+=("warn");     DEP_DETAILS+=("$2"); }

# --- Phase 1: Audit — check every dependency without installing anything ---
audit_dependencies() {
  start_spinner "Checking dependencies..."

  # Xcode CLT (macOS only)
  local xcode_ok=false
  if [ "$OS" = "macos" ]; then
    if xcode-select -p >/dev/null 2>&1 \
       && /usr/bin/xcrun --find clang >/dev/null 2>&1; then
      dep_found "Xcode CLT"
      xcode_ok=true
    else
      dep_missing "Xcode CLT" "not installed"
    fi
  else
    xcode_ok=true
  fi

  # curl
  if command_exists curl; then
    dep_found "curl"
  else
    dep_missing "curl" "not installed"
  fi

  # git — on macOS without CLT, git is a shim that pops up the install dialog,
  # so don't probe it; just report it as pending CLT install.
  if [ "$OS" = "macos" ] && [ "$xcode_ok" = false ]; then
    dep_missing "git" "provided by Xcode CLT"
  elif command_exists git && git --version >/dev/null 2>&1; then
    dep_found "git" "$(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
  else
    dep_missing "git" "not installed"
  fi

  # Node.js — source nvm/fnm and activate the target version if installed
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" 2>/dev/null || true
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || true
  fi
  if command_exists fnm; then
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    fnm use "$NODE_VERSION" >/dev/null 2>&1 || true
  fi
  local node_current=""
  command_exists node && node_current="$(node -v 2>/dev/null | sed 's/^v//')"

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
  else
    dep_missing "yarn" "not installed"
  fi

  # Build tools (Linux/Windows only — macOS is covered by Xcode CLT)
  case "$OS" in
    linux)
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
      ;;
    windows)
      if command_exists cl || [ -d "${PROGRAMFILES:-C:\\Program Files}/Microsoft Visual Studio" ]; then
        dep_found "Build tools" "Visual Studio"
      else
        dep_warn "Build tools" "VS Build Tools may be needed"
      fi
      ;;
  esac

  # Go — check standard install paths that may not be in PATH yet
  if ! command_exists go; then
    for go_path in /opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin /usr/local/go/bin /c/Go/bin "$HOME/go/bin"; do
      if [ -x "$go_path/go" ]; then
        export PATH="$go_path:$PATH"
        break
      fi
    done
  fi
  if command_exists go; then
    local go_ver go_major go_minor
    go_ver="$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/^go//')"
    go_major="$(echo "$go_ver" | cut -d. -f1)"
    go_minor="$(echo "$go_ver" | cut -d. -f2)"
    if [ "${go_major:-0}" -gt 1 ] 2>/dev/null || \
       { [ "${go_major:-0}" -eq 1 ] && [ "${go_minor:-0}" -ge 24 ]; } 2>/dev/null; then
      dep_found "Go" "${go_ver}"
    else
      dep_upgrade "Go" "${go_ver} → ${GO_VERSION}"
    fi
  else
    dep_missing "Go" "need ${GO_VERSION}+"
  fi

  # Python (optional — warn only)
  local python_ver=""
  for cmd in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command_exists "$cmd"; then
      local ver minor
      ver="$($cmd --version 2>/dev/null | grep -oE '3\.[0-9]+' | head -1)" || continue
      minor="$(echo "$ver" | cut -d. -f2)"
      if [ "${minor:-0}" -ge 10 ] 2>/dev/null; then
        python_ver="$($cmd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
        break
      fi
    fi
  done
  if [ -n "$python_ver" ]; then
    dep_found "Python" "${python_ver}"
  else
    dep_warn "Python" "3.10+ not found — training features unavailable"
  fi

  stop_spinner
}

# --- Phase 2: Show the audit results ---
print_dep_plan() {
  local i name status detail
  for i in "${!DEP_NAMES[@]}"; do
    name="${DEP_NAMES[$i]}"
    status="${DEP_STATUSES[$i]}"
    detail="${DEP_DETAILS[$i]}"
    case "$status" in
      ok)      printf "  ${CHECK}  %-24s${DIM}%s${RESET}\n" "$name" "$detail" ;;
      install) printf "  ${CROSS}  %-24s${YELLOW}%s${RESET}\n" "$name" "$detail" ;;
      upgrade) printf "  ${WARN_SYM}  %-24s${YELLOW}%s${RESET}\n" "$name" "$detail" ;;
      warn)    printf "  ${WARN_SYM}  %-24s${DIM}%s${RESET}\n" "$name" "$detail" ;;
    esac
  done
  echo ""

  if [ "$DEP_WORK_NEEDED" = true ]; then
    local install_count=0 upgrade_count=0
    for status in "${DEP_STATUSES[@]}"; do
      case "$status" in
        install) install_count=$((install_count + 1)) ;;
        upgrade) upgrade_count=$((upgrade_count + 1)) ;;
      esac
    done
    local summary=""
    [ "$install_count" -gt 0 ] && summary="${install_count} to install"
    if [ "$upgrade_count" -gt 0 ]; then
      [ -n "$summary" ] && summary="$summary, "
      summary="${summary}${upgrade_count} to upgrade"
    fi
    printf "  ${ARROW}  ${BOLD}%s${RESET}\n" "$summary"
  else
    printf "  ${CHECK}  ${BOLD}All dependencies satisfied${RESET}\n"
  fi
}

# --- Phase 3: Individual installers (install/upgrade only, no pre-check) ---

install_xcode_clt() {
  # Recheck — may have been installed between audit and now
  if xcode-select -p >/dev/null 2>&1 \
     && /usr/bin/xcrun --find clang >/dev/null 2>&1; then
    step_ok "Xcode Command Line Tools"
    return
  fi

  xcode-select --install >/dev/null 2>&1 || true
  step_warn "User authorization needed for Xcode Command Line Tools — approve the dialog to continue"

  local waited=0
  while ! /usr/bin/xcrun --find clang >/dev/null 2>&1; do
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -ge 1800 ]; then
      step_fail "Xcode CLT installation timed out — please install manually and re-run"
    fi
  done
  step_ok "Xcode Command Line Tools installed"
}

install_curl() {
  case "$OS" in
    macos) ;;
    linux)
      require_sudo "curl" "is required for downloading packages and needs user authorization to install"
      start_spinner "Installing curl..."
      case "$(detect_pkg_manager)" in
        apt)    run_silent "curl" sudo apt-get update -qq && run_silent "curl" sudo apt-get install -yqq curl ;;
        dnf)    run_silent "curl" sudo dnf install -y curl ;;
        yum)    run_silent "curl" sudo yum install -y curl ;;
        pacman) run_silent "curl" sudo pacman -Sy --noconfirm curl ;;
        *)      step_fail "Cannot install curl — install manually and re-run" ;;
      esac ;;
    windows) step_fail "curl not found — please install Git for Windows" ;;
  esac
  command_exists curl || step_fail "curl installation failed"
  step_ok "curl installed"
}

install_git() {
  # On macOS, Xcode CLT provides git — recheck after CLT install
  if command_exists git && git --version >/dev/null 2>&1; then
    step_ok "git $(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
    return
  fi

  case "$OS" in
    macos)
      start_spinner "Installing git..."
      if command_exists brew; then
        run_silent "git" brew install git
      else
        step_fail "git not available — Xcode CLT installation may have failed"
      fi
      ;;
    linux)
      require_sudo "git" "is required for source control and needs user authorization to install"
      start_spinner "Installing git..."
      case "$(detect_pkg_manager)" in
        apt)    run_silent "git" sudo apt-get update -qq && run_silent "git" sudo apt-get install -yqq git ;;
        dnf)    run_silent "git" sudo dnf install -y git ;;
        yum)    run_silent "git" sudo yum install -y git ;;
        pacman) run_silent "git" sudo pacman -Sy --noconfirm git ;;
        *)      step_fail "Cannot install git — install manually and re-run" ;;
      esac ;;
    windows) step_fail "Please install Git for Windows: https://git-scm.com/download/win" ;;
  esac
  command_exists git || step_fail "git installation failed"
  step_ok "git installed"
}

install_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    return
  fi
  run_silent "nvm" bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  . "$NVM_DIR/nvm.sh"
  command_exists nvm || step_fail "nvm installation failed"
}

install_fnm() {
  if command_exists fnm; then return; fi
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

install_node() {
  start_spinner "Installing Node.js v${NODE_VERSION}..."
  if [ "$OS" = "windows" ]; then
    install_fnm
    run_silent "node" fnm install "$NODE_VERSION"
    run_silent "node" fnm use "$NODE_VERSION"
    eval "$(fnm env --shell bash 2>/dev/null)" || true
  else
    install_nvm
    run_silent "node" nvm install "$NODE_VERSION"
    run_silent "node" nvm use "$NODE_VERSION"
  fi
  command_exists node || step_fail "Node.js installation failed"
  step_ok "Node.js $(node -v)"
}

install_yarn() {
  start_spinner "Installing yarn..."
  run_silent "yarn" bash -c 'corepack enable 2>/dev/null || npm install -g yarn'
  command_exists yarn || step_fail "yarn installation failed"
  step_ok "yarn $(yarn --version)"
}

install_build_tools() {
  case "$OS" in
    linux)
      local pkgs_needed=""
      command_exists make    || pkgs_needed="$pkgs_needed build-essential"
      command_exists python3 || pkgs_needed="$pkgs_needed python3"
      require_sudo "Build tools (${pkgs_needed# })" "are required for compiling native modules and need user authorization to install"
      start_spinner "Installing build tools..."
      case "$(detect_pkg_manager)" in
        apt)    run_silent "build-tools" sudo apt-get update -qq && run_silent "build-tools" sudo apt-get install -yqq $pkgs_needed ;;
        dnf)    run_silent "build-tools" sudo dnf install -y gcc gcc-c++ make python3 ;;
        yum)    run_silent "build-tools" sudo yum install -y gcc gcc-c++ make python3 ;;
        pacman) run_silent "build-tools" sudo pacman -Sy --noconfirm base-devel python ;;
        *)      step_warn "Please ensure C/C++ build tools are installed" ; return ;;
      esac
      ;;
    windows)
      run_silent "build-tools" npm install --global windows-build-tools 2>/dev/null || true
      step_warn "VS Build Tools — install manually if native modules fail"
      return
      ;;
  esac
  step_ok "Build tools installed"
}

install_go() {
  case "$OS" in
    macos)
      if command_exists brew; then
        start_spinner "Installing Go ${GO_VERSION}..."
        run_silent "go" brew install "go@1.24" 2>/dev/null \
          || run_silent "go" brew install go 2>/dev/null \
          || run_silent "go" brew upgrade go
        run_silent "go" brew link --overwrite "go@1.24" 2>/dev/null || true
      else
        require_sudo "Go ${GO_VERSION}" "is required for building backend services and needs user authorization to install to /usr/local"
        start_spinner "Installing Go ${GO_VERSION}..."
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
      require_sudo "Go ${GO_VERSION}" "is required for building backend services and needs user authorization to install to /usr/local"
      start_spinner "Installing Go ${GO_VERSION}..."
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
  # Re-bootstrap PATH so newly installed Go bin dir is picked up
  bootstrap_path
  command_exists go    || step_fail "Go installation failed"
  command_exists gofmt || step_fail "Go installation failed"
  step_ok "Go $(go version | grep -oE 'go[0-9]+\.[0-9]+\.[0-9]+')"
}

# --- Phase 4: Execute the plan — install/upgrade only what's needed ---
execute_dep_plan() {
  echo ""
  local i name status
  for i in "${!DEP_NAMES[@]}"; do
    name="${DEP_NAMES[$i]}"
    status="${DEP_STATUSES[$i]}"
    [ "$status" = "ok" ] || [ "$status" = "warn" ] && continue

    case "$name" in
      "Xcode CLT")    install_xcode_clt ;;
      "curl")         install_curl ;;
      "git")          install_git ;;
      "Node.js")      install_node ;;
      "yarn")         install_yarn ;;
      "Build tools")  install_build_tools ;;
      "Go")           install_go ;;
    esac
  done
}

# --- Phase 5: Verify everything works ---
verify_dependencies() {
  local failed=""

  if [ "$OS" = "macos" ] && ! /usr/bin/xcrun --find clang >/dev/null 2>&1; then
    failed="${failed} Xcode CLT"
  fi
  command_exists curl  || failed="${failed} curl"
  command_exists git   || failed="${failed} git"
  command_exists node  || failed="${failed} node"
  command_exists yarn  || failed="${failed} yarn"
  command_exists go    || failed="${failed} go"

  if [ -n "$failed" ]; then
    step_fail "Dependencies still missing after install:${failed} — check ${INSTALL_LOG}"
  fi
}

# --- Main entry point ---
install_dependencies() {
  section "Dependencies"
  audit_dependencies
  print_dep_plan
  if [ "$DEP_WORK_NEEDED" = true ]; then
    execute_dep_plan
    echo ""
    verify_dependencies
    printf "\n  ${CHECK}  ${BOLD}All dependencies satisfied${RESET}\n"
  fi
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
  # Always fetch latest from remote
  run_silent "fetch" git fetch origin --tags --force 2>/dev/null || true

  if [ "$INSTALL_REF" = "main" ]; then
    run_silent "checkout" git checkout main 2>/dev/null || true
    # Force-reset to match remote — installer should always use latest code
    run_silent "reset" git reset --hard origin/main 2>/dev/null || true
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

# Safely remove the install directory.
# Guards against empty/dangerous paths and verifies it looks like our repo.
safe_remove_install_dir() {
  local dir="$1"

  # Never remove empty, root, or home paths
  if [ -z "$dir" ] || [ "$dir" = "/" ] || [ "$dir" = "$HOME" ]; then
    step_fail "Refusing to remove dangerous path: '${dir}'"
  fi

  # Must be an absolute path under $HOME
  case "$dir" in
    "$HOME"/*) ;; # OK — under home directory
    *) step_fail "Refusing to remove path outside \$HOME: '${dir}'" ;;
  esac

  # Must contain our repo marker (package.json with sulla-desktop)
  if [ -d "$dir" ]; then
    if [ -f "$dir/package.json" ] && grep -q '"sulla-desktop"' "$dir/package.json" 2>/dev/null; then
      rm -rf "$dir"
    elif [ -d "$dir/.git" ]; then
      # Has .git but no package.json — still likely ours, allow removal
      rm -rf "$dir"
    else
      step_fail "Directory '${dir}' does not look like a sulla-desktop repo — refusing to remove"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Reset first-run state so the app re-runs its setup wizard on next launch.
# Removes only the settings file and fallback lock — does NOT touch the Lima
# VM, Docker containers, volumes, or any other user data.
# ---------------------------------------------------------------------------
reset_first_run_state() {
  local removed=false

  # 1. settings.json — its absence triggers _isFirstRun = true
  case "$OS" in
    macos)
      local settings_file="$HOME/Library/Preferences/rancher-desktop/settings.json"
      local fallback_file="$HOME/Library/Application Support/Sulla Desktop/sulla-settings-fallback.json"
      ;;
    linux)
      local settings_file="$HOME/.config/rancher-desktop/settings.json"
      local fallback_file="$HOME/.config/Sulla Desktop/sulla-settings-fallback.json"
      ;;
    windows)
      local settings_file="$LOCALAPPDATA/rancher-desktop/settings.json"
      local fallback_file="$LOCALAPPDATA/Sulla Desktop/sulla-settings-fallback.json"
      ;;
  esac

  if [ -f "$settings_file" ]; then
    rm -f "$settings_file"
    removed=true
  fi

  # 2. Fallback file — contains sullaInstalled flag that also blocks first-run
  if [ -f "$fallback_file" ]; then
    rm -f "$fallback_file"
    removed=true
  fi

  if [ "$removed" = true ]; then
    echo "  [nightly] Reset first-run state (containers & data preserved)" >> "$INSTALL_LOG"
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

  # Nightly: wipe repo and reset first-run state so setup runs again.
  # This does NOT delete user data (Lima VM, containers, volumes).
  if [ "$USE_NIGHTLY" = true ] && [ -d "$INSTALL_DIR" ]; then
    safe_remove_install_dir "$INSTALL_DIR"
    reset_first_run_state
  fi

  if [ -d "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    REPO_DIR="$(pwd)"
  elif [ -d "$INSTALL_DIR" ]; then
    safe_remove_install_dir "$INSTALL_DIR"
    run_silent "clone" git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    REPO_DIR="$(pwd)"
  else
    run_silent "clone" git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    REPO_DIR="$(pwd)"
  fi

  checkout_version
  step_ok "Repository ready (${INSTALL_REF})"
}

# ---------------------------------------------------------------------------
# Artifact verification — check real files, not exit codes
# ---------------------------------------------------------------------------

# Verify that yarn install produced a working node_modules tree.
# Only checks what yarn install actually creates — node_modules.
# Platform binaries (rdctl, docker, kubectl) and preload.js are
# produced by postinstall/build, verified separately in build_app.
verify_install_artifacts() {
  [ -f "node_modules/.yarn-integrity" ] || return 1
  [ -d "node_modules/electron" ]        || return 1
  return 0
}

# Verify that yarn build produced a launchable application.
# Checks both the webpack output (dist/) and the platform binary (rdctl).
# Every failed check is logged so we know exactly what's missing.
verify_build_artifacts() {
  local ok=true

  if [ ! -f "dist/app/background.js" ]; then
    echo "VERIFY FAIL: dist/app/background.js missing" >> "$INSTALL_LOG"
    ok=false
  fi
  if [ ! -f "dist/app/index.html" ]; then
    echo "VERIFY FAIL: dist/app/index.html missing" >> "$INSTALL_LOG"
    ok=false
  fi

  # rdctl must exist and be executable on the host platform
  local rdctl_bin=""
  case "$OS" in
    macos)   rdctl_bin="resources/darwin/bin/rdctl" ;;
    linux)   rdctl_bin="resources/linux/bin/rdctl" ;;
    windows) rdctl_bin="resources/win32/bin/rdctl.exe" ;;
  esac
  if [ -n "$rdctl_bin" ]; then
    if [ ! -f "$rdctl_bin" ]; then
      echo "VERIFY FAIL: $rdctl_bin missing" >> "$INSTALL_LOG"
      ok=false
    elif ! "$rdctl_bin" version >/dev/null 2>&1 && \
         ! "$rdctl_bin" --version >/dev/null 2>&1 && \
         ! "$rdctl_bin" paths >/dev/null 2>&1; then
      echo "VERIFY FAIL: $rdctl_bin exists but cannot execute ($(file "$rdctl_bin" 2>/dev/null || echo 'unknown arch'))" >> "$INSTALL_LOG"
      ok=false
    fi
  fi

  # Lima (limactl) must exist on macOS and Linux — the VM won't start without it
  local limactl_bin=""
  case "$OS" in
    macos)   limactl_bin="resources/darwin/lima/bin/limactl" ;;
    linux)   limactl_bin="resources/linux/lima/bin/limactl" ;;
  esac
  if [ -n "$limactl_bin" ] && [ ! -x "$limactl_bin" ]; then
    echo "VERIFY FAIL: $limactl_bin missing or not executable" >> "$INSTALL_LOG"
    ok=false
  fi

  [ "$ok" = true ]
}

# Dump full install verification results — shows every check with pass/fail
dump_install_verification() {
  echo ""
  printf "  ${WHITE}${BOLD}Install Verification Report${RESET}\n"
  printf "  ${DIM}──────────────────────────${RESET}\n"

  local all_ok=true

  # node_modules integrity
  if [ -f "node_modules/.yarn-integrity" ]; then
    printf "  ${CHECK}  node_modules/.yarn-integrity\n"
  else
    printf "  ${CROSS}  node_modules/.yarn-integrity ${RED}MISSING${RESET}\n"
    all_ok=false
  fi

  # Electron
  if [ -d "node_modules/electron" ]; then
    printf "  ${CHECK}  node_modules/electron/\n"
  else
    printf "  ${CROSS}  node_modules/electron/ ${RED}MISSING${RESET}\n"
    all_ok=false
  fi

  # Show last 30 lines of install log for context
  echo ""
  printf "  ${DIM}Last 30 lines of %s:${RESET}\n" "$INSTALL_LOG"
  tail -30 "$INSTALL_LOG" 2>/dev/null | while IFS= read -r line; do
    printf "  ${DIM}  %s${RESET}\n" "$line"
  done
  echo ""

  if [ "$all_ok" = true ]; then
    return 0
  else
    return 1
  fi
}

# Dump full build verification results
dump_build_verification() {
  echo ""
  printf "  ${WHITE}${BOLD}Build Verification Report${RESET}\n"
  printf "  ${DIM}────────────────────────${RESET}\n"

  if [ -f "dist/app/background.js" ]; then
    printf "  ${CHECK}  dist/app/background.js\n"
  else
    printf "  ${CROSS}  dist/app/background.js ${RED}MISSING${RESET}\n"
  fi

  if [ -f "dist/app/index.html" ]; then
    printf "  ${CHECK}  dist/app/index.html\n"
  else
    printf "  ${CROSS}  dist/app/index.html ${RED}MISSING${RESET}\n"
  fi

  # rdctl platform binary
  local rdctl_bin=""
  case "$OS" in
    macos)   rdctl_bin="resources/darwin/bin/rdctl" ;;
    linux)   rdctl_bin="resources/linux/bin/rdctl" ;;
    windows) rdctl_bin="resources/win32/bin/rdctl.exe" ;;
  esac
  if [ -n "$rdctl_bin" ]; then
    if [ ! -f "$rdctl_bin" ]; then
      printf "  ${CROSS}  %s ${RED}MISSING${RESET}\n" "$rdctl_bin"
    elif "$rdctl_bin" version >/dev/null 2>&1 || \
         "$rdctl_bin" --version >/dev/null 2>&1 || \
         "$rdctl_bin" paths >/dev/null 2>&1; then
      printf "  ${CHECK}  %s\n" "$rdctl_bin"
    else
      printf "  ${CROSS}  %s ${RED}EXISTS BUT FAILED TO EXECUTE${RESET}\n" "$rdctl_bin"
      printf "    ${DIM}arch: $(file "$rdctl_bin" 2>/dev/null || echo 'unknown')${RESET}\n"
    fi
  fi

  # Lima (limactl) — required on macOS/Linux for VM management
  local limactl_bin=""
  case "$OS" in
    macos)   limactl_bin="resources/darwin/lima/bin/limactl" ;;
    linux)   limactl_bin="resources/linux/lima/bin/limactl" ;;
  esac
  if [ -n "$limactl_bin" ]; then
    if [ -x "$limactl_bin" ]; then
      printf "  ${CHECK}  %s\n" "$limactl_bin"
    elif [ -f "$limactl_bin" ]; then
      printf "  ${CROSS}  %s ${RED}EXISTS BUT NOT EXECUTABLE${RESET}\n" "$limactl_bin"
    else
      printf "  ${CROSS}  %s ${RED}MISSING${RESET}\n" "$limactl_bin"
      printf "    ${DIM}Lima was not downloaded during postinstall — the VM cannot start without it.${RESET}\n"
      printf "    ${DIM}Try: rm -rf node_modules && bash install.sh${RESET}\n"
    fi
  fi

  # Show what IS in dist/app
  echo ""
  printf "  ${DIM}Contents of dist/app/:${RESET}\n"
  if [ -d "dist/app" ]; then
    ls -la dist/app/ 2>/dev/null | while IFS= read -r line; do
      printf "  ${DIM}  %s${RESET}\n" "$line"
    done
  else
    printf "  ${DIM}  (directory does not exist)${RESET}\n"
  fi

  # Show last 30 lines of install log for context
  echo ""
  printf "  ${DIM}Last 30 lines of %s:${RESET}\n" "$INSTALL_LOG"
  tail -30 "$INSTALL_LOG" 2>/dev/null | while IFS= read -r line; do
    printf "  ${DIM}  %s${RESET}\n" "$line"
  done
  echo ""
}

# ---------------------------------------------------------------------------
# Pre-build PATH verification — catch missing tools before Node subprocesses
# fail with cryptic ENOENT errors deep in postinstall scripts.
# ---------------------------------------------------------------------------
verify_build_path() {
  local missing=""
  command_exists node   || missing="${missing} node"
  command_exists yarn   || missing="${missing} yarn"
  command_exists git    || missing="${missing} git"
  command_exists go     || missing="${missing} go"
  command_exists gofmt  || missing="${missing} gofmt"
  if [ -n "$missing" ]; then
    echo "PATH=$PATH" >> "$INSTALL_LOG"
    step_fail "Build cannot proceed — tools not in PATH:${missing}. Check ${INSTALL_LOG}"
  fi
}

# ---------------------------------------------------------------------------
# Install deps & build — with artifact verification
# ---------------------------------------------------------------------------
install_deps() {
  [ -f "package-lock.json" ] && rm -f package-lock.json

  if [ "$OS" = "windows" ]; then
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    fnm use "$NODE_VERSION" >/dev/null 2>&1 || true
  else
    install_nvm
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || true
  fi

  # Re-bootstrap PATH so Go, gofmt, git, and any other tools installed
  # during the dependency phase are visible to Node subprocesses (yarn
  # postinstall scripts call gofmt, git describe, etc.)
  bootstrap_path

  # Verify all build tools are reachable before handing off to Node
  verify_build_path

  # Idempotent: if all install artifacts already exist, skip entirely
  if verify_install_artifacts; then
    step_ok "Packages already installed — verified"
    return
  fi

  # On Linux, node-pty ships no prebuilds and must compile from source via
  # node-gyp.  Ensure node-gyp is globally available so lifecycle scripts
  # can find it regardless of installation order.
  if [ "$OS" = "linux" ] && ! command_exists node-gyp; then
    start_spinner "Installing node-gyp (needed for native modules on Linux)..."
    run_silent "node-gyp" npm install -g node-gyp
    step_ok "node-gyp installed"
  fi

  start_spinner "Installing packages..."
  run_with_status "Installing packages" yarn install --ignore-engines --ignore-platform || true
  stop_spinner

  # Don't trust the exit code — verify artifacts instead.
  if verify_install_artifacts; then
    step_ok "Packages installed"
  else
    dump_install_verification
    step_fail "Package installation incomplete — see report above"
  fi
}

build_app() {
  # Idempotent: if build artifacts are already valid for this ref, skip
  if verify_build_artifacts; then
    local build_ref=""
    [ -f "dist/.build-ref" ] && build_ref="$(cat dist/.build-ref 2>/dev/null)"
    if [ "$build_ref" = "$INSTALL_REF" ]; then
      step_ok "Build up to date (${INSTALL_REF})"
      return
    fi
    if [ -z "$build_ref" ]; then
      # No ref marker but valid build — accept it
      step_ok "Build artifacts present (cached)"
      return
    fi
    # Stale build from a different ref — rebuild
    step_warn "Stale build (${build_ref}) — rebuilding for ${INSTALL_REF}"
    rm -rf dist
  fi

  if [ -d "dist" ]; then
    rm -rf dist
  fi

  # Re-verify PATH before build (nvm/fnm may have altered it)
  bootstrap_path
  verify_build_path

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

  start_spinner "Compiling desktop application..."
  run_with_status "Compiling" env NODE_OPTIONS="--max-old-space-size=$heap_mb" yarn build || true
  stop_spinner

  # Verify by artifacts, not exit code
  if verify_build_artifacts; then
    echo "$INSTALL_REF" > dist/.build-ref
    step_ok "Desktop application compiled"
  else
    dump_build_verification
    step_fail "Compilation failed — see report above"
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
Exec=bash -c 'export SULLA_PROJECT_DIR="$REPO_DIR" && cd "$REPO_DIR" && NODE_NO_WARNINGS=1 npx electron .'
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
          \$sc.Arguments = '/c cd /d \"${repo_win_path}\" && set SULLA_PROJECT_DIR=${repo_win_path} && npx electron .';
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
      SULLA_PROJECT_DIR="$REPO_DIR" NODE_NO_WARNINGS=1 nohup npx electron . >>"$log_file" 2>&1 &
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
      cmd.exe /C "start /B cmd /C \"cd /d ${repo_win_path} && set NODE_NO_WARNINGS=1 && set SULLA_PROJECT_DIR=${repo_win_path} && npx electron . >> ${log_win_path} 2>&1\"" 2>/dev/null \
        || SULLA_PROJECT_DIR="$REPO_DIR" NODE_NO_WARNINGS=1 npx electron . >>"$log_file" 2>&1 &
      step_ok "Sulla Desktop launched"
      ;;
  esac

  APP_LOG_FILE="$log_file"
}

# ---------------------------------------------------------------------------
# Final success banner
# ---------------------------------------------------------------------------
print_success() {
  # Ensure no spinner is still running before printing the banner
  stop_spinner 2>/dev/null

  echo ""
  echo ""
  printf "  ${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}\n"
  printf "  ${GREEN}${BOLD}║                                                          ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║   ${CHECK}  ${WHITE}Installation Complete!${GREEN}                            ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║                                                          ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║   ${RESET}${DIM}Everything was installed properly.${GREEN}${BOLD}                  ║${RESET}\n"
  printf "  ${GREEN}${BOLD}║   ${RESET}${DIM}Sulla is booting up — you can now close this terminal.${GREEN}${BOLD}║${RESET}\n"
  printf "  ${GREEN}${BOLD}║                                                          ║${RESET}\n"
  printf "  ${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}\n"
  echo ""
}

# ---------------------------------------------------------------------------
# Auto-close the terminal window after a brief pause
# ---------------------------------------------------------------------------
auto_close_terminal() {
  sleep 3
  case "$OS" in
    macos)
      # Close the Terminal.app or iTerm2 window via AppleScript
      if [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
        osascript -e 'tell application "Terminal" to close front window' 2>/dev/null || true
      elif [ "$TERM_PROGRAM" = "iTerm.app" ]; then
        osascript -e 'tell application "iTerm2" to close current session of current window' 2>/dev/null || true
      fi
      ;;
    linux)
      # Send SIGHUP to the parent shell to close the terminal
      kill -HUP "$PPID" 2>/dev/null || true
      ;;
    windows)
      # Exit the Git Bash / MSYS2 window
      exit 0
      ;;
  esac
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

  # Done — kill any lingering spinner and show the final banner
  stop_spinner 2>/dev/null
  show_cursor
  print_success
  auto_close_terminal
}

main "$@"
