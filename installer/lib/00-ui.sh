#!/usr/bin/env bash
# ============================================================================
# 00-ui.sh — Terminal UI Primitives
# ============================================================================
# Colors, spinners, progress bars, and output helpers.
# All functions are global (no namespace prefix) since they're used everywhere.
# ============================================================================

# ---------------------------------------------------------------------------
# Colors & Symbols
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
# NOTE: Do NOT truncate here — install.sh already initializes the log in Phase 1.
# Truncating would wipe all bootstrap diagnostic logs.
INSTALL_LOG="/tmp/sulla-install.log"

# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------
# Usage: log TAG "message"
#   log BOOT "Detected macOS arm64"
#   log DEPS "Auditing dependencies..."
#   log BUILD "yarn install starting"
#   log ASSERT "FAIL: Command 'go' not found in PATH"
#
# Tags: BOOT, PLATFORM, DEPS, REPO, BUILD, VERIFY, ASSERT, ERROR, FALLBACK,
#       UI, MACOS, LINUX, WINDOWS, PATH, NODE, GO, GIT, YARN, LIMA, RDCTL,
#       XCODE, SHORTCUT, LAUNCH, CLEANUP
# ---------------------------------------------------------------------------
log() {
  local tag="$1"; shift
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  printf "[%s] [%-8s] %s\n" "$ts" "$tag" "$*" >> "$INSTALL_LOG"
}

# Log environment snapshot — called once at startup for debugging
log_env_snapshot() {
  log BOOT "=== Environment Snapshot ==="
  log BOOT "OS: $(uname -s) $(uname -r) $(uname -m)"
  log BOOT "Shell: $SHELL (running as $(ps -p $$ -o comm= 2>/dev/null || echo unknown))"
  log BOOT "User: $(whoami)"
  log BOOT "HOME: $HOME"
  log BOOT "PWD: $(pwd)"
  log BOOT "PATH: $PATH"
  log BOOT "INSTALL_DIR: ${INSTALL_DIR:-not set}"
  log BOOT "USE_NIGHTLY: ${USE_NIGHTLY:-not set}"
  log BOOT "Terminal: ${TERM_PROGRAM:-unknown} / ${TERM:-unknown}"
  log BOOT "Stdin is terminal: $([ -t 0 ] && echo yes || echo no)"
  log BOOT "=== End Snapshot ==="
}

# ---------------------------------------------------------------------------
# Cursor management
# ---------------------------------------------------------------------------
hide_cursor() { printf "\033[?25l"; }
show_cursor() { printf "\033[?25h"; }

# Ensure cursor is restored on exit
ui::cleanup() {
  stop_spinner 2>/dev/null
  show_cursor
  if [ "${INSTALL_FAILED:-false}" = true ]; then
    echo ""
    printf "  ${DIM}Full log: %s${RESET}\n" "$INSTALL_LOG"
  fi
}
trap ui::cleanup EXIT

# ---------------------------------------------------------------------------
# Line control
# ---------------------------------------------------------------------------
clear_line() { printf "\r\033[2K"; }

# ---------------------------------------------------------------------------
# Spinner
# ---------------------------------------------------------------------------
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

stop_spinner() {
  if [ -n "${SPINNER_PID:-}" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
    kill "$SPINNER_PID" 2>/dev/null
    wait "$SPINNER_PID" 2>/dev/null || true
  fi
  SPINNER_PID=""
  clear_line
}

# ---------------------------------------------------------------------------
# Step markers
# ---------------------------------------------------------------------------
step_ok() {
  stop_spinner
  printf "  ${CHECK}  %s\n" "$1"
  STEP_RESULTS+=("ok|$1")
  log UI "OK: $1"
}

step_fail() {
  stop_spinner
  printf "  ${CROSS}  %s\n" "$1"
  STEP_RESULTS+=("fail|$1")
  INSTALL_FAILED=true
  show_cursor
  log ERROR "FAIL: $1"

  printf "\n  ${RED}${BOLD}Installation failed.${RESET}\n"
  printf "  ${DIM}Check the log for details: %s${RESET}\n\n" "$INSTALL_LOG"

  offer_error_report "$1"
  exit 1
}

step_warn() {
  stop_spinner
  printf "  ${WARN_SYM}  %s\n" "$1"
  STEP_RESULTS+=("warn|$1")
  log UI "WARN: $1"
}

# ---------------------------------------------------------------------------
# Section header
# ---------------------------------------------------------------------------
section() {
  echo ""
  printf "  ${WHITE}${BOLD}%s${RESET}\n" "$1"
  printf "  ${DIM}%s${RESET}\n" "$(printf '%.0s─' $(seq 1 ${#1}))"
  log UI "========== SECTION: $1 =========="
}

# ---------------------------------------------------------------------------
# Progress bar
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Run a command silently, capturing output to log
# ---------------------------------------------------------------------------
run_silent() {
  local desc="$1"
  shift
  log CMD "[$desc] Starting: $*"
  if "$@" >> "$INSTALL_LOG" 2>&1; then
    log CMD "[$desc] Completed successfully"
    return 0
  else
    local rc=$?
    log CMD "[$desc] FAILED with exit code $rc"
    return $rc
  fi
}

# ---------------------------------------------------------------------------
# Run a command with live status updates on the spinner
# ---------------------------------------------------------------------------
run_with_status() {
  local label="$1"
  shift
  log CMD "[$label] Starting (with status): $*"

  local current_phase="$label"
  local last_update=0
  local bytes_read=0

  local rws_output rws_done
  rws_output="$(mktemp "${TMPDIR:-/tmp}/rws_output.XXXXXX")"
  rws_done="$(mktemp "${TMPDIR:-/tmp}/rws_done.XXXXXX")"
  rm -f "$rws_done"

  ( "$@" > "$rws_output" 2>&1; echo $? > "$rws_done" ) &

  while [ ! -f "$rws_done" ]; do
    local new_output
    new_output="$(tail -c +$((bytes_read + 1)) "$rws_output" 2>/dev/null)"
    if [ -n "$new_output" ]; then
      echo "$new_output" >> "$INSTALL_LOG"
      bytes_read="$(wc -c < "$rws_output")"

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

  local rc
  rc="$(cat "$rws_done" 2>/dev/null)"
  rc="${rc:-1}"

  local remaining
  remaining="$(tail -c +$((bytes_read + 1)) "$rws_output" 2>/dev/null)"
  [ -n "$remaining" ] && echo "$remaining" >> "$INSTALL_LOG"

  if [ "$rc" -ne 0 ]; then
    log CMD "[$label] FAILED with exit code $rc"
  else
    log CMD "[$label] Completed successfully"
  fi

  rm -f "$rws_output" "$rws_done"
  stop_spinner 2>/dev/null
  return "$rc"
}

# ---------------------------------------------------------------------------
# Prompt the user for sudo access with a clear explanation
# ---------------------------------------------------------------------------
require_sudo() {
  local package="$1"
  local reason="$2"
  log SUDO "Checking sudo for: $package ($reason)"
  if sudo -n true 2>/dev/null; then
    log SUDO "Already authenticated"
    return 0
  fi
  stop_spinner
  echo ""
  printf "  ${ARROW}  ${BOLD}%s${RESET} %s\n" "$package" "$reason"
  printf "     ${DIM}Enter your password to continue:${RESET}\n"
  echo ""
  if sudo -v 2>/dev/null; then
    log SUDO "Authentication successful for: $package"
    echo ""
    return 0
  else
    log SUDO "Authentication FAILED for: $package"
    step_fail "sudo authentication failed — cannot continue without user authorization"
  fi
}

# ---------------------------------------------------------------------------
# Success banner
# ---------------------------------------------------------------------------
ui::print_success() {
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
