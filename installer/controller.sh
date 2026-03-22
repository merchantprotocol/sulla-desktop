#!/usr/bin/env bash
# ============================================================================
# controller.sh — Main Installation Orchestrator
# ============================================================================
# Walks the user through the entire install process in a linear, predictable
# sequence. All OS-specific logic is delegated via dispatch().
# ============================================================================

controller::run() {
  # Sanity check: OS must be set before controller runs
  if [ -z "${OS:-}" ]; then
    echo "FATAL: \$OS is not set — cannot run controller" >&2
    exit 1
  fi
  log BOOT "Controller starting (OS=$OS)"
  log BOOT "Arguments: $*"

  local args=("$@")

  # Parse arguments
  for arg in "${args[@]}"; do
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

  # ── Phase 1: Pre-flight ──────────────────────────────────────────────
  log BOOT "=== Phase 1: Pre-flight ==="
  section "Pre-flight Checks"
  dispatch preflight
  log BOOT "Pre-flight dispatch complete"
  assert_min_disk_gb "$HOME" "$MIN_DISK_GB"
  log BOOT "Disk space check passed: $(dispatch get_free_disk_gb "$HOME") GB available"
  step_ok "Disk space: $(dispatch get_free_disk_gb "$HOME") GB available"
  assert_github_access
  log BOOT "GitHub access verified"

  # ── Phase 2: Dependencies ────────────────────────────────────────────
  log BOOT "=== Phase 2: Dependencies ==="
  deps::run
  log BOOT "Dependencies phase complete"

  # ── Phase 3: Version & Repository ────────────────────────────────────
  log BOOT "=== Phase 3: Setup ==="
  section "Setup"
  repo::resolve_version
  log BOOT "Version resolved"
  repo::ensure
  log BOOT "Repository ready"

  # ── Phase 4: Build ───────────────────────────────────────────────────
  log BOOT "=== Phase 4: Build ==="
  build::run
  log BOOT "Build phase complete"

  # ── Phase 5: Finalize ────────────────────────────────────────────────
  log BOOT "=== Phase 5: Finalize ==="
  section "Finalize"
  dispatch create_shortcut
  log BOOT "Shortcut created"
  dispatch launch_app
  log BOOT "App launched"

  # ── Done ─────────────────────────────────────────────────────────────
  stop_spinner 2>/dev/null
  show_cursor
  ui::print_success
  ui::auto_close_terminal
  log BOOT "Installation complete"
}
