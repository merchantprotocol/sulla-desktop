#!/usr/bin/env bash
# ============================================================================
# 40-build.sh — Build Pipeline
# ============================================================================
# Handles yarn install and yarn build as a completely separate concern from
# OS dependency installation. Asserts prerequisites, verifies artifacts.
# ============================================================================

# ---------------------------------------------------------------------------
# Verify all build tools are in PATH before starting
# ---------------------------------------------------------------------------
build::verify_prerequisites() {
  log BUILD "Verifying build prerequisites"
  local missing=""
  for tool in node yarn git go gofmt; do
    if command_exists "$tool"; then
      log BUILD "  $tool: found at $(command -v "$tool" 2>/dev/null || echo 'unknown')"
    else
      log BUILD "  $tool: NOT FOUND"
      missing="${missing} $tool"
    fi
  done

  if [ -n "$missing" ]; then
    log BUILD "Prerequisite check FAILED — missing:${missing}"
    log BUILD "PATH=$PATH"
    echo "PATH=$PATH" >> "$INSTALL_LOG"
    assert_fail "Build cannot proceed — tools not in PATH:${missing}. Re-run dependency installation."
  fi
  log BUILD "All build prerequisites satisfied"
}

# ---------------------------------------------------------------------------
# Artifact verification
# ---------------------------------------------------------------------------
build::verify_install_artifacts() {
  log BUILD "Checking install artifacts"
  if [ -f "node_modules/.yarn-integrity" ]; then
    log BUILD "  node_modules/.yarn-integrity: present"
  else
    log BUILD "  node_modules/.yarn-integrity: MISSING"
    return 1
  fi
  if [ -d "node_modules/electron" ]; then
    log BUILD "  node_modules/electron/: present"
  else
    log BUILD "  node_modules/electron/: MISSING"
    return 1
  fi
  log BUILD "Install artifacts verified OK"
  return 0
}

build::verify_build_artifacts() {
  log BUILD "Checking build artifacts"
  if [ -f "dist/app/background.js" ]; then
    log BUILD "  dist/app/background.js: present ($(wc -c < dist/app/background.js 2>/dev/null || echo '?') bytes)"
  else
    log BUILD "  dist/app/background.js: MISSING"
    return 1
  fi
  if [ -f "dist/app/index.html" ]; then
    log BUILD "  dist/app/index.html: present ($(wc -c < dist/app/index.html 2>/dev/null || echo '?') bytes)"
  else
    log BUILD "  dist/app/index.html: MISSING"
    return 1
  fi
  log BUILD "Build artifacts verified OK"
  return 0
}

# ---------------------------------------------------------------------------
# Compute optimal heap size based on available RAM
# ---------------------------------------------------------------------------
build::compute_heap_mb() {
  local ram_gb
  ram_gb="$(dispatch get_ram_gb)"
  log BUILD "Detected RAM: ${ram_gb:-unknown} GB"
  local heap_mb
  if [ "${ram_gb:-0}" -le 8 ] 2>/dev/null; then
    heap_mb="4096"
  elif [ "${ram_gb:-0}" -le 16 ] 2>/dev/null; then
    heap_mb="8192"
  else
    heap_mb="12288"
  fi
  log BUILD "Heap size chosen: ${heap_mb} MB (for ${ram_gb:-?} GB RAM)"
  echo "$heap_mb"
}

# ---------------------------------------------------------------------------
# Dump install verification report (on failure)
# ---------------------------------------------------------------------------
build::dump_install_report() {
  log BUILD "Generating install verification report"
  echo ""
  printf "  ${WHITE}${BOLD}Install Verification Report${RESET}\n"
  printf "  ${DIM}──────────────────────────${RESET}\n"

  if [ -f "node_modules/.yarn-integrity" ]; then
    printf "  ${CHECK}  node_modules/.yarn-integrity\n"
  else
    printf "  ${CROSS}  node_modules/.yarn-integrity ${RED}MISSING${RESET}\n"
  fi

  if [ -d "node_modules/electron" ]; then
    printf "  ${CHECK}  node_modules/electron/\n"
  else
    printf "  ${CROSS}  node_modules/electron/ ${RED}MISSING${RESET}\n"
  fi

  echo ""
  printf "  ${DIM}Last 30 lines of %s:${RESET}\n" "$INSTALL_LOG"
  tail -30 "$INSTALL_LOG" 2>/dev/null | while IFS= read -r line; do
    printf "  ${DIM}  %s${RESET}\n" "$line"
  done
  echo ""
}

# ---------------------------------------------------------------------------
# Dump build verification report (on failure)
# ---------------------------------------------------------------------------
build::dump_build_report() {
  log BUILD "Generating build verification report"
  echo ""
  printf "  ${WHITE}${BOLD}Build Verification Report${RESET}\n"
  printf "  ${DIM}────────────────────────${RESET}\n"

  if [ -f "dist/app/background.js" ]; then
    log BUILD "  report: dist/app/background.js present"
    printf "  ${CHECK}  dist/app/background.js\n"
  else
    log BUILD "  report: dist/app/background.js MISSING"
    printf "  ${CROSS}  dist/app/background.js ${RED}MISSING${RESET}\n"
  fi

  if [ -f "dist/app/index.html" ]; then
    log BUILD "  report: dist/app/index.html present"
    printf "  ${CHECK}  dist/app/index.html\n"
  else
    log BUILD "  report: dist/app/index.html MISSING"
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
      log BUILD "  report: $rdctl_bin MISSING"
      printf "  ${CROSS}  %s ${RED}MISSING${RESET}\n" "$rdctl_bin"
    elif "$rdctl_bin" version >/dev/null 2>&1 || \
         "$rdctl_bin" --version >/dev/null 2>&1 || \
         "$rdctl_bin" paths >/dev/null 2>&1; then
      log BUILD "  report: $rdctl_bin OK (executable)"
      printf "  ${CHECK}  %s\n" "$rdctl_bin"
    else
      log BUILD "  report: $rdctl_bin EXISTS BUT FAILED TO EXECUTE — arch: $(file "$rdctl_bin" 2>/dev/null || echo 'unknown')"
      printf "  ${CROSS}  %s ${RED}EXISTS BUT FAILED TO EXECUTE${RESET}\n" "$rdctl_bin"
      printf "    ${DIM}arch: $(file "$rdctl_bin" 2>/dev/null || echo 'unknown')${RESET}\n"
    fi
  fi

  # Lima (macOS/Linux only)
  local limactl_bin=""
  case "$OS" in
    macos)   limactl_bin="resources/darwin/lima/bin/limactl" ;;
    linux)   limactl_bin="resources/linux/lima/bin/limactl" ;;
  esac
  if [ -n "$limactl_bin" ]; then
    if [ -x "$limactl_bin" ]; then
      log BUILD "  report: $limactl_bin OK (executable)"
      printf "  ${CHECK}  %s\n" "$limactl_bin"
    elif [ -f "$limactl_bin" ]; then
      log BUILD "  report: $limactl_bin EXISTS BUT NOT EXECUTABLE"
      printf "  ${CROSS}  %s ${RED}EXISTS BUT NOT EXECUTABLE${RESET}\n" "$limactl_bin"
    else
      log BUILD "  report: $limactl_bin MISSING"
      printf "  ${CROSS}  %s ${RED}MISSING${RESET}\n" "$limactl_bin"
      printf "    ${DIM}Lima was not downloaded during postinstall — the VM cannot start without it.${RESET}\n"
    fi
  fi

  # Show dist/app contents
  echo ""
  printf "  ${DIM}Contents of dist/app/:${RESET}\n"
  if [ -d "dist/app" ]; then
    ls -la dist/app/ 2>/dev/null | while IFS= read -r line; do
      printf "  ${DIM}  %s${RESET}\n" "$line"
    done
  else
    printf "  ${DIM}  (directory does not exist)${RESET}\n"
  fi

  # Show log tail
  echo ""
  printf "  ${DIM}Last 30 lines of %s:${RESET}\n" "$INSTALL_LOG"
  tail -30 "$INSTALL_LOG" 2>/dev/null | while IFS= read -r line; do
    printf "  ${DIM}  %s${RESET}\n" "$line"
  done
  echo ""
}

# ---------------------------------------------------------------------------
# yarn install — install packages + postinstall (downloads Lima, builds rdctl)
# ---------------------------------------------------------------------------
build::yarn_install() {
  log BUILD "Starting yarn install phase"

  # Ensure we have the right Node version active
  log BUILD "Dispatching pre_yarn_install hook"
  dispatch_optional pre_yarn_install
  log BUILD "pre_yarn_install hook completed"

  # Remove stale lock file that conflicts with yarn
  if [ -f "package-lock.json" ]; then
    log BUILD "Removing stale package-lock.json"
    rm -f package-lock.json
  fi

  # Re-bootstrap PATH so all tools are visible to Node subprocesses
  log BUILD "Re-bootstrapping PATH for Node subprocesses"
  bootstrap_path
  build::verify_prerequisites

  # Idempotent: skip if artifacts already exist — BUT not on nightly,
  # because nightly pulls new code and dependencies may have changed
  if [ "$USE_NIGHTLY" = true ]; then
    log BUILD "Nightly mode — forcing yarn install (ignoring cached artifacts)"
  elif build::verify_install_artifacts; then
    log BUILD "Install artifacts already present — skipping yarn install"
    step_ok "Packages already installed — verified"
    return
  fi

  # Snapshot environment before yarn install — this is the #1 failure point
  log BUILD "=== Pre-yarn-install environment snapshot ==="
  log BUILD "  pwd: $(pwd)"
  log BUILD "  node: $(node -v 2>/dev/null || echo 'NOT FOUND') at $(command -v node 2>/dev/null || echo 'NOT IN PATH')"
  log BUILD "  npm: $(npm -v 2>/dev/null || echo 'NOT FOUND') at $(command -v npm 2>/dev/null || echo 'NOT IN PATH')"
  log BUILD "  yarn: $(yarn --version 2>/dev/null || echo 'NOT FOUND') at $(command -v yarn 2>/dev/null || echo 'NOT IN PATH')"
  log BUILD "  go: $(go version 2>/dev/null || echo 'NOT FOUND') at $(command -v go 2>/dev/null || echo 'NOT IN PATH')"
  log BUILD "  gofmt: $(command -v gofmt 2>/dev/null || echo 'NOT IN PATH')"
  log BUILD "  git: $(git --version 2>/dev/null || echo 'NOT FOUND') at $(command -v git 2>/dev/null || echo 'NOT IN PATH')"
  log BUILD "  M1=${M1:-not set}"
  log BUILD "  PATH=$PATH"
  log BUILD "  free disk: $(dispatch get_free_disk_gb "$(pwd)") GB"
  log BUILD "  package.json exists: $([ -f package.json ] && echo 'yes' || echo 'NO')"
  log BUILD "  yarn.lock exists: $([ -f yarn.lock ] && echo 'yes' || echo 'NO')"
  log BUILD "=== End snapshot ==="

  log BUILD "Running: yarn install --ignore-engines --ignore-platform"
  start_spinner "Installing packages..."
  if run_with_status "Installing packages" yarn install --ignore-engines --ignore-platform; then
    stop_spinner
    log BUILD "yarn install completed successfully (exit 0)"
  else
    stop_spinner
    log BUILD "yarn install exited non-zero — will check artifacts"
    # Don't trust exit code alone — check artifacts
    echo "yarn install exited non-zero, checking artifacts..." >> "$INSTALL_LOG"
  fi

  # Log postinstall artifacts — this catches silent Lima/rdctl download failures early
  log BUILD "=== Post-yarn-install artifact inventory ==="
  log BUILD "  node_modules/.yarn-integrity: $([ -f node_modules/.yarn-integrity ] && echo 'present' || echo 'MISSING')"
  log BUILD "  node_modules/electron/: $([ -d node_modules/electron ] && echo 'present' || echo 'MISSING')"

  # Log platform binary state immediately after postinstall
  local _rdctl_path="" _lima_path=""
  case "$OS" in
    macos)   _rdctl_path="resources/darwin/bin/rdctl"; _lima_path="resources/darwin/lima/bin/limactl" ;;
    linux)   _rdctl_path="resources/linux/bin/rdctl"; _lima_path="resources/linux/lima/bin/limactl" ;;
    windows) _rdctl_path="resources/win32/bin/rdctl.exe" ;;
  esac
  if [ -n "$_rdctl_path" ]; then
    if [ -f "$_rdctl_path" ]; then
      log BUILD "  rdctl ($OS): present ($(wc -c < "$_rdctl_path" 2>/dev/null || echo '?') bytes, $(file "$_rdctl_path" 2>/dev/null || echo 'unknown type'))"
    else
      log BUILD "  rdctl ($OS): MISSING at $_rdctl_path — postinstall may have failed to compile it"
    fi
  fi
  if [ -n "$_lima_path" ]; then
    if [ -f "$_lima_path" ]; then
      log BUILD "  limactl ($OS): present ($(wc -c < "$_lima_path" 2>/dev/null || echo '?') bytes, $(file "$_lima_path" 2>/dev/null || echo 'unknown type'))"
    else
      log BUILD "  limactl ($OS): MISSING at $_lima_path — postinstall may have failed to download Lima"
    fi
  fi
  log BUILD "=== End artifact inventory ==="

  # Verify by artifacts, not exit code
  if build::verify_install_artifacts; then
    log BUILD "Post-install artifact verification passed"
    step_ok "Packages installed"
  else
    log BUILD "Post-install artifact verification FAILED"
    build::dump_install_report
    assert_fail "Package installation incomplete — see Install Verification Report above"
  fi
}

# ---------------------------------------------------------------------------
# yarn build — compile the desktop application
# ---------------------------------------------------------------------------
build::yarn_build() {
  log BUILD "Starting yarn build phase"

  # Idempotent: skip if build is up to date
  if build::verify_build_artifacts; then
    local build_ref=""
    [ -f "dist/.build-ref" ] && build_ref="$(cat dist/.build-ref 2>/dev/null)"
    if [ "$build_ref" = "$INSTALL_REF" ]; then
      log BUILD "Build already up to date — build-ref matches INSTALL_REF (${INSTALL_REF})"
      step_ok "Build up to date (${INSTALL_REF})"
      return
    fi
    if [ -z "$build_ref" ] && [ "$USE_NIGHTLY" != true ]; then
      log BUILD "Build artifacts present with no build-ref — using cached build"
      step_ok "Build artifacts present (cached)"
      return
    fi
    # Stale build — ref changed or nightly with unknown build state
    log BUILD "Stale build detected: build-ref=${build_ref:-none}, INSTALL_REF=${INSTALL_REF} — removing dist/"
    step_warn "Stale build (${build_ref:-unknown}) — rebuilding for ${INSTALL_REF}"
    rm -rf dist
  fi

  if [ -d "dist" ]; then
    log BUILD "Removing existing dist/ directory"
    rm -rf dist
  fi

  # Re-verify PATH (nvm/fnm may have altered it)
  log BUILD "Re-bootstrapping PATH for build"
  bootstrap_path
  build::verify_prerequisites

  local heap_mb
  heap_mb="$(build::compute_heap_mb)"

  # Snapshot before build — OOM and missing tools are common here
  log BUILD "=== Pre-yarn-build snapshot ==="
  log BUILD "  pwd: $(pwd)"
  log BUILD "  heap: ${heap_mb} MB"
  log BUILD "  free RAM: $(dispatch get_ram_gb) GB total"
  log BUILD "  free disk: $(dispatch get_free_disk_gb "$(pwd)") GB"
  log BUILD "  node: $(node -v 2>/dev/null || echo 'NOT FOUND') at $(command -v node 2>/dev/null || echo 'NOT IN PATH')"
  log BUILD "  PATH=$PATH"
  log BUILD "=== End snapshot ==="

  log BUILD "Running: NODE_OPTIONS='--max-old-space-size=$heap_mb' yarn build"
  start_spinner "Compiling desktop application..."
  if run_with_status "Compiling" env NODE_OPTIONS="--max-old-space-size=$heap_mb" yarn build; then
    stop_spinner
    log BUILD "yarn build completed successfully (exit 0)"
  else
    stop_spinner
    log BUILD "yarn build exited non-zero — will check artifacts"
    echo "yarn build exited non-zero, checking artifacts..." >> "$INSTALL_LOG"
  fi

  # Verify by artifacts
  if build::verify_build_artifacts; then
    log BUILD "Post-build artifact verification passed — writing build-ref=${INSTALL_REF}"
    echo "$INSTALL_REF" > dist/.build-ref
    step_ok "Desktop application compiled"
  else
    log BUILD "Post-build artifact verification FAILED"
    build::dump_build_report
    assert_fail "Compilation failed — see Build Verification Report above"
  fi
}

# ---------------------------------------------------------------------------
# Verify platform binaries (rdctl, limactl) after build
# ---------------------------------------------------------------------------
build::verify_platform_binaries() {
  log BUILD "Verifying platform binaries (rdctl, limactl)"
  start_spinner "Verifying platform binaries..."
  dispatch verify_platform_binaries
  stop_spinner
  log BUILD "Platform binary verification complete"
  step_ok "Platform binaries verified (rdctl, limactl)"
}

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
build::run() {
  log BUILD "=== Build phase starting ==="
  section "Build"
  log BUILD "Phase 1/3: yarn install"
  build::yarn_install
  log BUILD "Phase 2/3: yarn build"
  build::yarn_build
  log BUILD "Phase 3/3: verify platform binaries"
  build::verify_platform_binaries
  log BUILD "=== Build phase complete ==="
}
