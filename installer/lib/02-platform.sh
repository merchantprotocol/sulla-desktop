#!/usr/bin/env bash
# ============================================================================
# 02-platform.sh — Platform Detection, Dispatch & Validation
# ============================================================================
# OS/arch detection, package manager detection, PATH bootstrap,
# the dispatch() polymorphism pattern, and OS module validation.
# ============================================================================

# ---------------------------------------------------------------------------
# Config constants
# ---------------------------------------------------------------------------
REPO_URL="https://github.com/merchantprotocol/sulla-desktop.git"
REPO_OWNER="merchantprotocol"
REPO_NAME="sulla-desktop"
REPO_DIR=""
INSTALL_DIR="$HOME/.sulla-desktop"
NODE_VERSION="22.22.0"
GO_VERSION="1.24.2"
MIN_DISK_GB=10
USE_NIGHTLY="${USE_NIGHTLY:-false}"
INSTALL_REF=""

# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------
command_exists() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# OS detection
# ---------------------------------------------------------------------------
detect_os() {
  local raw
  raw="$(uname -s)"
  log PLATFORM "detect_os: uname -s = '${raw}'"
  local result
  case "$raw" in
    Darwin*)  result="macos"  ;;
    Linux*)   result="linux"  ;;
    MINGW*|MSYS*|CYGWIN*) result="windows" ;;
    *)
      log PLATFORM "detect_os: FATAL unsupported OS '${raw}'"
      assert_fail "Unsupported OS: ${raw}"
      ;;
  esac
  log PLATFORM "detect_os: detected '${result}'"
  echo "$result"
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  log PLATFORM "detect_arch: '${arch}'"
  echo "$arch"
}

# ---------------------------------------------------------------------------
# Package manager detection (Linux)
# ---------------------------------------------------------------------------
detect_pkg_manager() {
  log PLATFORM "detect_pkg_manager: probing for known package managers"
  local result="unknown"
  if command_exists apt-get; then result="apt"
  elif command_exists dnf;     then result="dnf"
  elif command_exists yum;     then result="yum"
  elif command_exists pacman;  then result="pacman"
  elif command_exists brew;    then result="brew"
  fi
  log PLATFORM "detect_pkg_manager: detected '${result}'"
  echo "$result"
}

# ---------------------------------------------------------------------------
# PATH Bootstrap — ensure common binary locations are reachable
# ---------------------------------------------------------------------------
bootstrap_path() {
  log PATH "bootstrap_path: starting PATH bootstrap"
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
    "/c/Program Files/Go/bin"
    # Cargo / Rust (fnm, other tools)
    "$HOME/.cargo/bin"
    # Common Linux paths
    /usr/bin
    /usr/sbin
    /bin
    /sbin
  )

  local added=0
  for dir in "${candidates[@]}"; do
    case ":$PATH:" in
      *":$dir:"*)
        log PATH "bootstrap_path: already in PATH, skipping '${dir}'"
        continue
        ;;
    esac
    if [ -d "$dir" ]; then
      export PATH="$dir:$PATH"
      log PATH "bootstrap_path: added '${dir}'"
      added=$((added + 1))
    else
      log PATH "bootstrap_path: not a directory, skipping '${dir}'"
    fi
  done
  log PATH "bootstrap_path: complete — added ${added} directories"
}

# ---------------------------------------------------------------------------
# Dispatch — simulated polymorphism
# ---------------------------------------------------------------------------
# Calls ${OS}::${method_name} with any extra arguments.
# If the method doesn't exist, it's a fatal error (missing interface method).
# ---------------------------------------------------------------------------
dispatch() {
  local method="$1"; shift
  local fn="${OS}::${method}"
  log DISPATCH "Calling ${fn}($*)"
  if declare -F "$fn" >/dev/null 2>&1; then
    "$fn" "$@"
    log DISPATCH "${fn} completed"
  else
    log DISPATCH "FATAL: ${fn} not implemented"
    assert_fail "BUG: ${fn} is not implemented for platform '${OS}'"
  fi
}

# ---------------------------------------------------------------------------
# Optional dispatch — like dispatch but silently returns 0 if not implemented
# Used for hooks that only some OS modules need (e.g. pre_yarn_install)
# ---------------------------------------------------------------------------
dispatch_optional() {
  local method="$1"; shift
  local fn="${OS}::${method}"
  log DISPATCH "Optional call ${fn}($*)"
  if declare -F "$fn" >/dev/null 2>&1; then
    "$fn" "$@"
    log DISPATCH "${fn} completed (optional)"
  else
    log DISPATCH "${fn} not implemented — skipping (optional)"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# OS Module Interface Validation
# ---------------------------------------------------------------------------
# Every OS module must implement these methods. Missing = fatal at load time.
# ---------------------------------------------------------------------------
REQUIRED_OS_METHODS=(
  preflight
  audit_deps
  install_xcode_clt
  install_curl
  install_git
  install_node
  install_yarn
  install_build_tools
  install_go
  verify_deps
  verify_platform_binaries
  create_shortcut
  launch_app
  get_ram_gb
  get_free_disk_gb
  get_log_dir
)

validate_os_module() {
  local os="$1"
  log VALIDATE "validate_os_module: validating module '${os}'"
  log VALIDATE "validate_os_module: checking ${#REQUIRED_OS_METHODS[@]} required methods"
  local missing=()
  for method in "${REQUIRED_OS_METHODS[@]}"; do
    if ! declare -F "${os}::${method}" >/dev/null 2>&1; then
      log VALIDATE "validate_os_module: MISSING ${os}::${method}"
      missing+=("${os}::${method}")
    else
      log VALIDATE "validate_os_module: OK ${os}::${method}"
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    log VALIDATE "validate_os_module: FAILED — ${#missing[@]} methods missing for '${os}'"
    printf "\n  ${RED}${BOLD}OS MODULE VALIDATION FAILED${RESET}\n"
    printf "  ${RED}Module '%s' is missing required methods:${RESET}\n" "$os"
    for m in "${missing[@]}"; do
      printf "    ${RED}✖  %s${RESET}\n" "$m"
    done
    printf "\n"
    exit 1
  fi
  log VALIDATE "validate_os_module: PASSED — all methods present for '${os}'"
}
