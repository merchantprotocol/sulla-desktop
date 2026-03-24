#!/usr/bin/env bash
# ============================================================================
# 30-repo.sh — Repository Management
# ============================================================================
# Version resolution, clone, checkout, and safe removal.
# ============================================================================

# ---------------------------------------------------------------------------
# Resolve the target version (release tag or --nightly)
# ---------------------------------------------------------------------------
repo::resolve_version() {
  log REPO "Resolving target version (USE_NIGHTLY=$USE_NIGHTLY)"
  if [ "$USE_NIGHTLY" = true ]; then
    INSTALL_REF="main"
    log REPO "Nightly mode — target ref: main (will resolve to SHA after checkout)"
    step_ok "Target: main (nightly)"
    return
  fi

  start_spinner "Checking for latest release..."
  local api_url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
  log REPO "Fetching latest release from: $api_url"
  local release_json
  release_json="$(curl -fsSL "$api_url" 2>/dev/null)" || {
    INSTALL_REF="main"
    log REPO "GitHub API request failed — falling back to main branch"
    step_warn "Could not fetch releases — using main branch"
    return
  }
  log REPO "GitHub API response received (${#release_json} bytes)"

  INSTALL_REF="$(echo "$release_json" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"

  if [ -z "$INSTALL_REF" ]; then
    INSTALL_REF="main"
    log REPO "No tag_name found in release JSON — falling back to main branch"
    step_warn "No releases found — using main branch"
    return
  fi

  log REPO "Resolved version: $INSTALL_REF"
  step_ok "Target: ${INSTALL_REF}"
}

# ---------------------------------------------------------------------------
# Checkout the resolved version
# ---------------------------------------------------------------------------
repo::checkout_version() {
  log REPO "Checking out version: $INSTALL_REF"
  log REPO "Fetching origin with tags..."
  run_silent "fetch" git fetch origin --tags --force 2>/dev/null || true
  log REPO "Fetch complete"

  if [ "$INSTALL_REF" = "main" ]; then
    log REPO "Target is main branch — checking out and resetting to origin/main"
    run_silent "checkout" git checkout main 2>/dev/null || true
    run_silent "reset" git reset --hard origin/main 2>/dev/null || true
    log REPO "Reset to origin/main complete"
  else
    local current_tag
    current_tag="$(git describe --tags --exact-match 2>/dev/null || true)"
    log REPO "Current tag: '${current_tag:-<none>}', target: '$INSTALL_REF'"
    if [ "$current_tag" = "$INSTALL_REF" ]; then
      log REPO "Already at target tag — no checkout needed"
      return
    fi
    log REPO "Attempting checkout of tag: $INSTALL_REF"
    run_silent "checkout" git checkout "$INSTALL_REF" 2>/dev/null || {
      log REPO "Direct checkout failed — fetching specific tag ref"
      run_silent "fetch-tag" git fetch origin "refs/tags/$INSTALL_REF:refs/tags/$INSTALL_REF" 2>/dev/null || true
      log REPO "Retrying checkout after tag fetch"
      run_silent "checkout" git checkout "$INSTALL_REF" || \
        assert_fail "Failed to checkout ${INSTALL_REF} — tag may not exist"
    }
    log REPO "Checkout of $INSTALL_REF succeeded"
  fi
}

# ---------------------------------------------------------------------------
# Safely remove the install directory
# ---------------------------------------------------------------------------
repo::safe_remove_install_dir() {
  local dir="$1"
  log REPO "Safe remove requested for: '${dir}'"

  # Safety: never remove empty, root, or home
  if [ -z "$dir" ] || [ "$dir" = "/" ] || [ "$dir" = "$HOME" ]; then
    log REPO "BLOCKED — dangerous path detected: '${dir}'"
    assert_fail "Refusing to remove dangerous path: '${dir}'"
  fi

  # Must be under $HOME
  case "$dir" in
    "$HOME"/*) log REPO "Path is under \$HOME — passed safety check" ;; # OK
    *)
      log REPO "BLOCKED — path is outside \$HOME: '${dir}'"
      assert_fail "Refusing to remove path outside \$HOME: '${dir}'"
      ;;
  esac

  # Must contain our repo marker
  if [ -d "$dir" ]; then
    if [ -f "$dir/package.json" ] && grep -q '"sulla-desktop"' "$dir/package.json" 2>/dev/null; then
      log REPO "Directory contains sulla-desktop package.json — removing: $dir"
      rm -rf "$dir"
      log REPO "Removal complete"
    elif [ -d "$dir/.git" ]; then
      log REPO "Directory contains .git — removing: $dir"
      rm -rf "$dir"
      log REPO "Removal complete"
    else
      log REPO "BLOCKED — directory does not look like sulla-desktop repo: $dir"
      assert_fail "Directory '${dir}' does not look like a sulla-desktop repo — refusing to remove"
    fi
  else
    log REPO "Directory does not exist, nothing to remove: $dir"
  fi
}

# ---------------------------------------------------------------------------
# Reset first-run state (nightly only)
# ---------------------------------------------------------------------------
repo::reset_first_run_state() {
  log REPO "Resetting first-run state (OS=$OS)"
  local removed=false
  local settings_file="" fallback_file=""

  case "$OS" in
    macos)
      settings_file="$HOME/Library/Preferences/rancher-desktop/settings.json"
      fallback_file="$HOME/Library/Application Support/Sulla Desktop/sulla-settings-fallback.json"
      ;;
    linux)
      settings_file="$HOME/.config/rancher-desktop/settings.json"
      fallback_file="$HOME/.config/Sulla Desktop/sulla-settings-fallback.json"
      ;;
    windows)
      settings_file="$LOCALAPPDATA/rancher-desktop/settings.json"
      fallback_file="$LOCALAPPDATA/Sulla Desktop/sulla-settings-fallback.json"
      ;;
  esac

  log REPO "Checking settings file: ${settings_file:-<not set>}"
  if [ -n "$settings_file" ] && [ -f "$settings_file" ]; then
    log REPO "Removing settings file: $settings_file"
    rm -f "$settings_file"
    removed=true
  else
    log REPO "Settings file not found or not set — skipping"
  fi

  log REPO "Checking fallback file: ${fallback_file:-<not set>}"
  if [ -n "$fallback_file" ] && [ -f "$fallback_file" ]; then
    log REPO "Removing fallback file: $fallback_file"
    rm -f "$fallback_file"
    removed=true
  else
    log REPO "Fallback file not found or not set — skipping"
  fi

  if [ "$removed" = true ]; then
    log REPO "First-run state reset complete (containers & data preserved)"
    echo "  [nightly] Reset first-run state (containers & data preserved)" >> "$INSTALL_LOG"
  else
    log REPO "No first-run state files found — nothing to reset"
  fi
}

# ---------------------------------------------------------------------------
# Ensure repo is cloned and at the right version
# ---------------------------------------------------------------------------
repo::ensure() {
  log REPO "Ensuring repository (INSTALL_DIR=$INSTALL_DIR, INSTALL_REF=$INSTALL_REF, USE_NIGHTLY=$USE_NIGHTLY)"
  start_spinner "Setting up repository..."

  # If we're already inside the sulla-desktop repo, use it
  if [ -f "package.json" ] && grep -q '"sulla-desktop"' package.json 2>/dev/null; then
    REPO_DIR="$(pwd)"
    log REPO "Detected in-place repo at: $REPO_DIR — using existing working tree"
    repo::checkout_version

    # Resolve INSTALL_REF to the actual commit SHA so the build cache
    # can detect when code has changed (same logic as the clone path below)
    if [ "$USE_NIGHTLY" = true ]; then
      local sha
      sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
      INSTALL_REF="main@${sha}"
      log REPO "Nightly (in-place): resolved to commit $sha (INSTALL_REF=$INSTALL_REF)"
    fi

    cd "$REPO_DIR" || assert_fail "Cannot cd to REPO_DIR: $REPO_DIR"
    step_ok "Repository ready (in-place, ${INSTALL_REF})"
    return
  fi

  # Nightly: wipe and reset first-run state
  if [ "$USE_NIGHTLY" = true ] && [ -d "$INSTALL_DIR" ]; then
    log REPO "Nightly mode with existing install dir — wiping and resetting first-run state"
    repo::safe_remove_install_dir "$INSTALL_DIR"
    repo::reset_first_run_state
  elif [ "$USE_NIGHTLY" = true ]; then
    log REPO "Nightly mode but no existing install dir — fresh clone path"
  fi

  if [ -d "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR/.git" ]; then
    log REPO "Existing git repo found at: $INSTALL_DIR — reusing"
    cd "$INSTALL_DIR"
    REPO_DIR="$(pwd)"
  elif [ -d "$INSTALL_DIR" ]; then
    log REPO "Directory exists but is not a git repo: $INSTALL_DIR — removing and cloning fresh"
    repo::safe_remove_install_dir "$INSTALL_DIR"
    log REPO "Cloning $REPO_URL into $INSTALL_DIR"
    run_silent "clone" git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    REPO_DIR="$(pwd)"
  else
    log REPO "No existing directory — cloning $REPO_URL into $INSTALL_DIR"
    run_silent "clone" git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    REPO_DIR="$(pwd)"
  fi

  log REPO "REPO_DIR set to: $REPO_DIR"

  # Verify clone succeeded
  assert_file "$INSTALL_DIR/package.json" "package.json in cloned repo"
  log REPO "Clone verification passed — package.json exists"

  repo::checkout_version

  # For nightly, resolve INSTALL_REF to the actual commit SHA so the build
  # cache can detect when code has changed (INSTALL_REF="main" never changes,
  # but the SHA does on every new commit)
  if [ "$USE_NIGHTLY" = true ]; then
    local sha
    sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
    INSTALL_REF="main@${sha}"
    log REPO "Nightly: resolved to commit $sha (INSTALL_REF=$INSTALL_REF)"
  fi

  log REPO "Repository ready at $INSTALL_REF"

  # Guarantee we're in REPO_DIR — all subsequent phases depend on this
  cd "$REPO_DIR" || assert_fail "Cannot cd to REPO_DIR: $REPO_DIR"
  log REPO "Working directory set to: $(pwd)"

  step_ok "Repository ready (${INSTALL_REF})"
}
