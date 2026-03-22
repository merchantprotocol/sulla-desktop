#!/usr/bin/env bash
# ============================================================================
# 20-deps.sh — Dependency Orchestration
# ============================================================================
# OS-agnostic dependency management: audit, plan, execute, verify.
# Delegates all OS-specific logic to the platform modules via dispatch().
# ============================================================================

# ---------------------------------------------------------------------------
# Audit tracking arrays
# ---------------------------------------------------------------------------
DEP_NAMES=()
DEP_STATUSES=()   # ok, install, upgrade, warn
DEP_DETAILS=()
DEP_WORK_NEEDED=false

dep_found()   { log DEPS "Found: $1 ${2:+(${2})}";           DEP_NAMES+=("$1"); DEP_STATUSES+=("ok");      DEP_DETAILS+=("${2:-}"); }
dep_missing() { log DEPS "Missing: $1 ($2)";                   DEP_NAMES+=("$1"); DEP_STATUSES+=("install");  DEP_DETAILS+=("$2");     DEP_WORK_NEEDED=true; }
dep_upgrade() { log DEPS "Upgrade needed: $1 ($2)";            DEP_NAMES+=("$1"); DEP_STATUSES+=("upgrade");  DEP_DETAILS+=("$2");     DEP_WORK_NEEDED=true; }
dep_warn()    { log DEPS "Warning: $1 ($2)";                   DEP_NAMES+=("$1"); DEP_STATUSES+=("warn");     DEP_DETAILS+=("$2"); }

# ---------------------------------------------------------------------------
# Phase 1: Audit — delegate to OS module
# ---------------------------------------------------------------------------
deps::audit() {
  log DEPS "Audit phase started"
  start_spinner "Checking dependencies..."
  dispatch audit_deps
  stop_spinner
  log DEPS "Audit phase completed — ${#DEP_NAMES[@]} dependencies checked"
}

# ---------------------------------------------------------------------------
# Phase 2: Print the audit results
# ---------------------------------------------------------------------------
deps::print_plan() {
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
    local install_count=0 upgrade_count=0 ok_count=0 warn_count=0
    for status in "${DEP_STATUSES[@]}"; do
      case "$status" in
        ok)      ok_count=$((ok_count + 1)) ;;
        install) install_count=$((install_count + 1)) ;;
        upgrade) upgrade_count=$((upgrade_count + 1)) ;;
        warn)    warn_count=$((warn_count + 1)) ;;
      esac
    done
    log DEPS "Plan summary: found=$ok_count, missing=$install_count, upgrade=$upgrade_count, warn=$warn_count"
    local summary=""
    [ "$install_count" -gt 0 ] && summary="${install_count} to install"
    if [ "$upgrade_count" -gt 0 ]; then
      [ -n "$summary" ] && summary="$summary, "
      summary="${summary}${upgrade_count} to upgrade"
    fi
    printf "  ${ARROW}  ${BOLD}%s${RESET}\n" "$summary"
  else
    log DEPS "Plan summary: all ${#DEP_NAMES[@]} dependencies satisfied — nothing to do"
    printf "  ${CHECK}  ${BOLD}All dependencies satisfied${RESET}\n"
  fi
}

# ---------------------------------------------------------------------------
# Phase 3: Execute — install/upgrade what's needed
# ---------------------------------------------------------------------------
# Maps dependency names to OS module installer methods via dispatch.
# The order matters: Xcode CLT must come first (provides git on macOS),
# curl before git (needed for downloads), git before node (needed for nvm),
# node before yarn, etc.
# ---------------------------------------------------------------------------
deps::execute_plan() {
  log DEPS "Executing dependency installation plan"
  echo ""
  local i name status

  # Define install order — this is the canonical dependency chain
  local -a INSTALL_ORDER=(
    "Xcode CLT"
    "curl"
    "git"
    "Build tools"
    "Node.js"
    "yarn"
    "Go"
  )

  # Map display names to dispatch method names
  deps::_name_to_method() {
    case "$1" in
      "Xcode CLT")    echo "install_xcode_clt" ;;
      "curl")         echo "install_curl" ;;
      "git")          echo "install_git" ;;
      "Build tools")  echo "install_build_tools" ;;
      "Node.js")      echo "install_node" ;;
      "yarn")         echo "install_yarn" ;;
      "Go")           echo "install_go" ;;
      *)
        log DEPS "BUG: No dispatch method mapped for dependency '$1'"
        echo ""
        ;;
    esac
  }

  for dep_name in "${INSTALL_ORDER[@]}"; do
    # Find this dep in the audit results
    local found=false
    for i in "${!DEP_NAMES[@]}"; do
      if [ "${DEP_NAMES[$i]}" = "$dep_name" ]; then
        local dep_status="${DEP_STATUSES[$i]}"
        if [ "$dep_status" = "install" ] || [ "$dep_status" = "upgrade" ]; then
          local method
          method="$(deps::_name_to_method "$dep_name")"
          if [ -n "$method" ]; then
            log DEPS "Processing '$dep_name': status=$dep_status, method=$method"
            dispatch "$method"
            log DEPS "Completed '$dep_name' via $method"
          else
            log DEPS "FATAL: Dependency '$dep_name' needs $dep_status but has no dispatch method mapped"
            assert_fail "BUG: No installer method mapped for dependency '${dep_name}'. Update deps::_name_to_method() in 20-deps.sh."
          fi
        else
          log DEPS "Skipping '$dep_name': status=$dep_status (no action needed)"
        fi
        found=true
        break
      fi
    done
    if [ "$found" = false ]; then
      log DEPS "Skipping '$dep_name': not present in audit results"
    fi
  done
  log DEPS "Dependency installation plan execution finished"
}

# ---------------------------------------------------------------------------
# Phase 4: Verify — assert everything works
# ---------------------------------------------------------------------------
deps::verify_all() {
  log DEPS "Verify phase started"
  echo ""
  start_spinner "Verifying all dependencies..."
  dispatch verify_deps
  stop_spinner
  log DEPS "Verify phase completed — all dependencies confirmed working"
  printf "\n  ${CHECK}  ${BOLD}All dependencies verified and working${RESET}\n"
}

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
deps::run() {
  log DEPS "=== Dependency orchestration started ==="
  section "Dependencies"
  log DEPS "Phase 1/4: Audit"
  deps::audit
  log DEPS "Phase 2/4: Print plan"
  deps::print_plan
  if [ "$DEP_WORK_NEEDED" = true ]; then
    log DEPS "Phase 3/4: Execute plan (work needed)"
    deps::execute_plan
    log DEPS "Phase 4/4: Verify"
    deps::verify_all
  else
    log DEPS "Phases 3-4 skipped: no work needed"
  fi
  log DEPS "=== Dependency orchestration finished ==="
}
