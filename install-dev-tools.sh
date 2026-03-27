#!/usr/bin/env bash
# ============================================================================
# Sulla Desktop — Developer Environment Setup
# ============================================================================
# Usage:
#   bash install-dev-tools.sh
#
# This script sets up developer tools that are not part of the main install:
#   1. Makes yarn globally accessible via shell profile (nvm + corepack)
#   2. Installs just (justfile command runner)
#
# Run this after install-dev.sh has completed successfully.
# Idempotent — safe to run multiple times.
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
NODE_VERSION="22.22.0"

# ---------------------------------------------------------------------------
# Terminal UI
# ---------------------------------------------------------------------------
GREEN="\033[1;32m"
RED="\033[1;31m"
YELLOW="\033[1;33m"
BLUE="\033[1;34m"
RESET="\033[0m"
CHECK="${GREEN}✔${RESET}"
CROSS="${RED}✖${RESET}"

step_ok()   { printf "  ${CHECK}  %b\n" "$1"; }
step_fail() { printf "  ${CROSS}  %b\n" "$1"; exit 1; }
step_skip() { printf "  ${CHECK}  %b ${YELLOW}(already installed)${RESET}\n" "$1"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Detect OS
# ---------------------------------------------------------------------------
detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "darwin" ;;
    Linux*)   echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)        echo "unknown" ;;
  esac
}

OS="$(detect_os)"

# ---------------------------------------------------------------------------
# Detect shell profile
# ---------------------------------------------------------------------------
detect_shell_profile() {
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/bash}")"

  case "$shell_name" in
    zsh)  echo "${HOME}/.zshrc" ;;
    bash)
      if [ -f "${HOME}/.bash_profile" ]; then
        echo "${HOME}/.bash_profile"
      else
        echo "${HOME}/.bashrc"
      fi
      ;;
    fish) echo "${HOME}/.config/fish/config.fish" ;;
    *)    echo "${HOME}/.profile" ;;
  esac
}

SHELL_PROFILE="$(detect_shell_profile)"

# ---------------------------------------------------------------------------
# 1. Make yarn globally accessible
# ---------------------------------------------------------------------------
setup_yarn() {
  printf "\n${BLUE}Setting up yarn...${RESET}\n"

  # Ensure nvm is loaded
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
  else
    step_fail "nvm not found — run install-dev.sh first"
  fi

  # Activate the correct node version
  nvm use "$NODE_VERSION" >/dev/null 2>&1 || nvm install "$NODE_VERSION" >/dev/null 2>&1
  nvm alias default "$NODE_VERSION" >/dev/null 2>&1

  # Enable corepack (ships with Node, provides yarn)
  corepack enable 2>/dev/null || npm install -g yarn >/dev/null 2>&1

  # Verify yarn works
  if ! command_exists yarn; then
    step_fail "yarn installation failed"
  fi

  # Ensure nvm auto-loads in new shells
  local nvm_snippet='export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'

  if ! grep -q 'NVM_DIR' "$SHELL_PROFILE" 2>/dev/null; then
    printf "\n# nvm (Node Version Manager)\n%s\n" "$nvm_snippet" >> "$SHELL_PROFILE"
    step_ok "Added nvm to ${SHELL_PROFILE}"
  else
    step_skip "nvm already in ${SHELL_PROFILE}"
  fi

  # Set default node version so yarn is always available
  step_ok "yarn $(yarn --version) — available globally via nvm default"
}

# ---------------------------------------------------------------------------
# 2. Install just (justfile command runner)
# ---------------------------------------------------------------------------
install_just() {
  printf "\n${BLUE}Setting up just...${RESET}\n"

  if command_exists just; then
    step_skip "just $(just --version 2>/dev/null | head -1)"
    return
  fi

  # Default install location for the curl installer
  local just_bin="${HOME}/.local/bin"

  case "$OS" in
    darwin)
      if command_exists brew; then
        brew install just >/dev/null 2>&1
      else
        curl -fsSL https://just.systems/install.sh | bash -s -- --to "$just_bin" >/dev/null 2>&1
      fi
      ;;
    linux)
      if command_exists brew; then
        brew install just >/dev/null 2>&1
      elif command_exists snap; then
        sudo snap install --edge --classic just >/dev/null 2>&1
      else
        curl -fsSL https://just.systems/install.sh | bash -s -- --to "$just_bin" >/dev/null 2>&1
      fi
      ;;
    windows)
      if command_exists scoop; then
        scoop install just >/dev/null 2>&1
      elif command_exists choco; then
        choco install just >/dev/null 2>&1
      else
        curl -fsSL https://just.systems/install.sh | bash -s -- --to "$just_bin" >/dev/null 2>&1
      fi
      ;;
    *)
      step_fail "Unsupported OS — install just manually: https://github.com/casey/just#installation"
      ;;
  esac

  # Ensure just is on PATH — check common install locations
  if ! command_exists just; then
    for dir in "$just_bin" "/opt/homebrew/bin" "/usr/local/bin" "/snap/bin"; do
      if [ -x "${dir}/just" ]; then
        ensure_path "$dir"
        break
      fi
    done
  fi

  if command_exists just; then
    step_ok "just $(just --version 2>/dev/null | head -1)"
  else
    step_fail "just installation failed — could not find just on PATH"
  fi
}

# Helper: ensure a directory is on PATH via shell profile
ensure_path() {
  local dir="$1"
  mkdir -p "$dir"
  if ! echo "$PATH" | tr ':' '\n' | grep -q "^${dir}$"; then
    export PATH="${dir}:${PATH}"
  fi
  if ! grep -q "$dir" "$SHELL_PROFILE" 2>/dev/null; then
    printf '\nexport PATH="%s:$PATH"\n' "$dir" >> "$SHELL_PROFILE"
    step_ok "Added ${dir} to PATH in ${SHELL_PROFILE}"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
printf "\n${BLUE}━━━ Sulla Desktop — Developer Setup ━━━${RESET}\n"

setup_yarn
install_just

printf "\n${GREEN}━━━ Developer environment ready ━━━${RESET}\n"
printf "  Restart your terminal or run: ${YELLOW}source ${SHELL_PROFILE}${RESET}\n\n"
