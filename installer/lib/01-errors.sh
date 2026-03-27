#!/usr/bin/env bash
# ============================================================================
# 01-errors.sh — Error Handling & Reporting
# ============================================================================
# Fail-loud error handling, fallback declarations, and error reporting.
# ============================================================================

ERROR_REPORT_URL="https://error-reports.merchantprotocol.workers.dev"

# ---------------------------------------------------------------------------
# Submit an error report to the Cloudflare worker
# ---------------------------------------------------------------------------
submit_error_report() {
  local step_name="$1"
  log ERROR "Submitting error report for: $step_name"
  local log_tail=""
  if [ -f "$INSTALL_LOG" ]; then
    log_tail="$(tail -80 "$INSTALL_LOG" 2>/dev/null \
      | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' \
      | awk '{printf "%s\\n", $0}' \
      | sed 's/\\n$//')"
  fi

  local os_platform os_version app_version
  os_platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
  os_version="$(uname -r)"
  app_version="${INSTALL_REF:-unknown}"

  local payload
  payload=$(printf '{
  "error_type": "install_failure",
  "error_message": "Installation failed at step: %s",
  "stack_trace": "%s",
  "app_version": "%s",
  "os_platform": "%s",
  "os_version": "%s",
  "user_context": "install-dev.sh — step: %s, nightly: %s"
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

# ---------------------------------------------------------------------------
# Ask user if they want to submit the error report
# ---------------------------------------------------------------------------
offer_error_report() {
  local step_name="$1"

  # If stdin is not a terminal (piped from curl), auto-submit
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

# ---------------------------------------------------------------------------
# try_with_fallback — Run a primary command, loudly fail, then try fallback
# ---------------------------------------------------------------------------
# Usage: try_with_fallback "description" primary_func -- fallback_func
#   or:  try_with_fallback "description" primary_func
#
# Functions (not raw commands) are expected so complex logic can be wrapped.
# If primary succeeds, returns 0.
# If primary fails and no fallback, calls assert_fail (fatal).
# If primary fails and fallback succeeds, prints a warning and returns 0.
# If both fail, calls assert_fail (fatal).
# ---------------------------------------------------------------------------
try_with_fallback() {
  local desc="$1"; shift

  # Split args on "--" into primary and fallback
  local primary="" fallback=""
  local in_fallback=false
  for arg in "$@"; do
    if [ "$arg" = "--" ]; then
      in_fallback=true
      continue
    fi
    if [ "$in_fallback" = true ]; then
      fallback="$arg"
    else
      primary="$arg"
    fi
  done

  # Run primary
  log FALLBACK "[$desc] Trying primary method: $primary"
  if "$primary"; then
    log FALLBACK "[$desc] Primary method succeeded"
    return 0
  fi

  # Primary failed — announce loudly
  log FALLBACK "[$desc] Primary method FAILED"
  printf "\n"
  printf "  ${RED}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}\n"
  printf "  ${RED}${BOLD}║  FAILED: %-48s ║${RESET}\n" "$desc"
  printf "  ${RED}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}\n"

  if [ -z "$fallback" ]; then
    log FALLBACK "[$desc] No fallback available — fatal"
    assert_fail "$desc — failed with no fallback available"
  fi

  log FALLBACK "[$desc] Attempting fallback method: $fallback"
  printf "  ${YELLOW}${BOLD}  ⚠ Attempting fallback...${RESET}\n\n"

  if "$fallback"; then
    log FALLBACK "[$desc] Fallback method succeeded"
    step_warn "$desc — used fallback method (succeeded)"
    return 0
  fi

  log FALLBACK "[$desc] Fallback method also FAILED — fatal"
  assert_fail "$desc — both primary and fallback methods failed"
}
