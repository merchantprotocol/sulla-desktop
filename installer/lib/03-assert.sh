#!/usr/bin/env bash
# ============================================================================
# 03-assert.sh — Assertion Framework
# ============================================================================
# Production-grade verification. Every assertion either passes silently or
# crashes hard with a giant red box. No silent failures. No hidden problems.
# Every check is logged with [ASSERT] tag for easy grep.
# ============================================================================

# ---------------------------------------------------------------------------
# assert_fail — The nuclear option. Big red box, error report, exit 1.
# ---------------------------------------------------------------------------
assert_fail() {
  local msg="$1"
  log ASSERT "FATAL: $msg"
  stop_spinner 2>/dev/null
  show_cursor 2>/dev/null

  printf "\n"
  printf "  ${RED}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}\n"
  printf "  ${RED}${BOLD}║  ASSERTION FAILED                                        ║${RESET}\n"
  printf "  ${RED}${BOLD}╟──────────────────────────────────────────────────────────╢${RESET}\n"

  # Word-wrap the message to fit in the box
  local line=""
  for word in $msg; do
    if [ $((${#line} + ${#word} + 1)) -gt 54 ]; then
      printf "  ${RED}${BOLD}║  %-56s║${RESET}\n" "$line"
      line="$word"
    else
      [ -n "$line" ] && line="$line $word" || line="$word"
    fi
  done
  [ -n "$line" ] && printf "  ${RED}${BOLD}║  %-56s║${RESET}\n" "$line"

  printf "  ${RED}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}\n"
  printf "\n"
  printf "  ${DIM}Full log: %s${RESET}\n\n" "$INSTALL_LOG"

  INSTALL_FAILED=true
  STEP_RESULTS+=("fail|ASSERT: $msg")

  offer_error_report "ASSERT: $msg"
  exit 1
}

# ---------------------------------------------------------------------------
# assert_command — Command must exist in PATH and execute successfully
# ---------------------------------------------------------------------------
# Catches: missing commands, EBADARCH, permission denied, broken symlinks
# ---------------------------------------------------------------------------
assert_command() {
  local cmd="$1"
  local ver_flag="${2:---version}"

  log ASSERT "Checking command '$cmd' exists and executes ($ver_flag)"

  if ! command -v "$cmd" >/dev/null 2>&1; then
    log ASSERT "FAIL: '$cmd' not found in PATH"
    log ASSERT "PATH=$PATH"
    assert_fail "Command '${cmd}' not found in PATH after installation. PATH=${PATH}"
  fi

  local location
  location="$(command -v "$cmd" 2>/dev/null)"
  log ASSERT "Found '$cmd' at: $location"

  # Verify it actually runs (catches arch mismatches, permission issues)
  if ! "$cmd" "$ver_flag" >/dev/null 2>&1; then
    local file_info=""
    if [ -f "$location" ]; then
      file_info="$(file "$location" 2>/dev/null || echo "unknown")"
    fi
    log ASSERT "FAIL: '$cmd' at $location fails to execute. file=$file_info"
    assert_fail "Command '${cmd}' exists at ${location} but fails to execute. File: ${file_info}"
  fi

  log ASSERT "PASS: '$cmd' exists and executes"
}

# ---------------------------------------------------------------------------
# assert_command_exists — Command must exist in PATH (no execution test)
# ---------------------------------------------------------------------------
# Use this for commands that don't support --version or need special args
# ---------------------------------------------------------------------------
assert_command_exists() {
  local cmd="$1"
  log ASSERT "Checking command '$cmd' exists in PATH"

  if ! command -v "$cmd" >/dev/null 2>&1; then
    log ASSERT "FAIL: '$cmd' not found in PATH"
    log ASSERT "PATH=$PATH"
    assert_fail "Command '${cmd}' not found in PATH. PATH=${PATH}"
  fi

  log ASSERT "PASS: '$cmd' found at $(command -v "$cmd")"
}

# ---------------------------------------------------------------------------
# assert_file — File must exist
# ---------------------------------------------------------------------------
assert_file() {
  local path="$1"
  local desc="${2:-$path}"
  log ASSERT "Checking file exists: $path ($desc)"

  if [ ! -f "$path" ]; then
    log ASSERT "FAIL: File missing: $path"
    # Log parent directory contents for debugging
    local parent_dir
    parent_dir="$(dirname "$path")"
    if [ -d "$parent_dir" ]; then
      log ASSERT "Contents of $parent_dir:"
      ls -la "$parent_dir" >> "$INSTALL_LOG" 2>&1
    else
      log ASSERT "Parent directory does not exist: $parent_dir"
    fi
    assert_fail "Required file missing: ${desc} (${path})"
  fi

  log ASSERT "PASS: File exists: $path ($(wc -c < "$path" 2>/dev/null || echo '?') bytes)"
}

# ---------------------------------------------------------------------------
# assert_executable — File must exist and be executable
# ---------------------------------------------------------------------------
assert_executable() {
  local path="$1"
  local desc="${2:-$path}"
  log ASSERT "Checking executable: $path ($desc)"

  if [ ! -f "$path" ]; then
    log ASSERT "FAIL: Executable missing: $path"
    local parent_dir
    parent_dir="$(dirname "$path")"
    if [ -d "$parent_dir" ]; then
      log ASSERT "Contents of $parent_dir:"
      ls -la "$parent_dir" >> "$INSTALL_LOG" 2>&1
    else
      log ASSERT "Parent directory does not exist: $parent_dir"
    fi
    assert_fail "Required executable missing: ${desc} (${path})"
  fi
  if [ ! -x "$path" ]; then
    log ASSERT "FAIL: File not executable: $path (perms: $(stat -f '%Sp' "$path" 2>/dev/null || stat -c '%a' "$path" 2>/dev/null || echo unknown))"
    assert_fail "File exists but not executable: ${desc} (${path}). Try: chmod +x ${path}"
  fi

  local file_info
  file_info="$(file "$path" 2>/dev/null || echo "unknown")"
  log ASSERT "PASS: Executable exists: $path ($file_info)"
}

# ---------------------------------------------------------------------------
# assert_executable_runs — File must exist, be executable, AND run
# ---------------------------------------------------------------------------
# This is the strongest check — catches EBADARCH errors on rdctl/limactl
# ---------------------------------------------------------------------------
assert_executable_runs() {
  local path="$1"
  local desc="${2:-$path}"
  shift 2
  local test_args=("${@:---version}")

  log ASSERT "Checking executable runs: $path ($desc) with args: ${test_args[*]}"

  assert_executable "$path" "$desc"

  if ! "$path" "${test_args[@]}" >/dev/null 2>&1; then
    local file_info
    file_info="$(file "$path" 2>/dev/null || echo "unknown")"
    local host_arch
    host_arch="$(uname -m)"
    log ASSERT "FAIL: Executable runs check failed. host_arch=$host_arch file=$file_info"
    assert_fail "${desc} exists and is executable but failed to run. Host arch: ${host_arch}. Binary: ${file_info}"
  fi

  log ASSERT "PASS: Executable runs: $path"
}

# ---------------------------------------------------------------------------
# assert_dir — Directory must exist
# ---------------------------------------------------------------------------
assert_dir() {
  local path="$1"
  local desc="${2:-$path}"
  log ASSERT "Checking directory exists: $path ($desc)"

  if [ ! -d "$path" ]; then
    log ASSERT "FAIL: Directory missing: $path"
    assert_fail "Required directory missing: ${desc} (${path})"
  fi

  log ASSERT "PASS: Directory exists: $path"
}

# ---------------------------------------------------------------------------
# assert_min_disk_gb — Enough free disk space
# ---------------------------------------------------------------------------
assert_min_disk_gb() {
  local path="$1"
  local min_gb="$2"
  local free_gb
  free_gb="$(dispatch get_free_disk_gb "$path")"

  log ASSERT "Checking disk space at $path: free=${free_gb:-unknown}GB required=${min_gb}GB"

  if [ -z "$free_gb" ]; then
    log ASSERT "WARN: Could not determine free disk space"
    step_warn "Could not determine free disk space at ${path}"
    return 0
  fi

  if [ "$free_gb" -lt "$min_gb" ] 2>/dev/null; then
    log ASSERT "FAIL: Insufficient disk space: ${free_gb}GB < ${min_gb}GB"
    assert_fail "Not enough disk space at ${path}: ${free_gb} GB free, need ${min_gb} GB"
  fi

  log ASSERT "PASS: Disk space OK: ${free_gb}GB >= ${min_gb}GB"
}

# ---------------------------------------------------------------------------
# assert_github_access — Verify we can reach GitHub before attempting clone
# ---------------------------------------------------------------------------
assert_github_access() {
  log ASSERT "Checking GitHub connectivity: https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"
  start_spinner "Checking GitHub connectivity..."
  local http_code
  http_code="$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time 10 \
    "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}" 2>/dev/null)" || http_code="000"

  log ASSERT "GitHub API response: HTTP $http_code"

  if [ "$http_code" = "200" ] || [ "$http_code" = "301" ] || [ "$http_code" = "302" ]; then
    log ASSERT "PASS: GitHub accessible (HTTP $http_code)"
    step_ok "GitHub accessible"
    return 0
  elif [ "$http_code" = "000" ]; then
    log ASSERT "FAIL: Network error reaching GitHub (HTTP 000)"
    assert_fail "Cannot reach GitHub (network error). Check your internet connection or firewall. curl exit code captured in log."
  elif [ "$http_code" = "401" ] || [ "$http_code" = "403" ]; then
    log ASSERT "FAIL: GitHub auth/rate limit (HTTP $http_code)"
    assert_fail "GitHub returned HTTP ${http_code} — authentication/rate limit issue. If using a private repo, ensure your credentials are configured."
  elif [ "$http_code" = "404" ]; then
    log ASSERT "FAIL: GitHub repo not found (HTTP 404)"
    assert_fail "GitHub repository ${REPO_OWNER}/${REPO_NAME} not found (HTTP 404). Is the repo name correct?"
  else
    log ASSERT "FAIL: Unexpected GitHub response (HTTP $http_code)"
    assert_fail "GitHub returned unexpected HTTP ${http_code}. Check your network and try again."
  fi
}

# ---------------------------------------------------------------------------
# assert_url_reachable — Generic URL reachability check
# ---------------------------------------------------------------------------
assert_url_reachable() {
  local url="$1"
  local desc="${2:-$url}"
  log ASSERT "Checking URL reachable: $url ($desc)"

  local http_code
  http_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null)" || http_code="000"

  log ASSERT "URL response: HTTP $http_code for $url"

  if [ "$http_code" = "000" ]; then
    assert_fail "Cannot reach ${desc} (${url}) — network error"
  elif [ "$http_code" -ge 400 ] 2>/dev/null; then
    assert_fail "Cannot reach ${desc} (${url}) — HTTP ${http_code}"
  fi

  log ASSERT "PASS: URL reachable: $url (HTTP $http_code)"
}
