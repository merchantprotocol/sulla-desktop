#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
set -euo pipefail

repeat=1; kill_at=""; app_input=""; vm_memory_gb=5; margin_gb=3; keep_failures=0; manual=0
usage() { cat <<'TXT'
Usage: scripts/first-run-vm-loop.sh --app /path/to/Sulla.app-or.dmg [--repeat N] [--kill-at PHASE] [--vm-memory-gb N] [--keep-failures] [--manual]
PHASE is a startup phase name emitted as "phase=<name>". The test instance is killed once at that phase and relaunched with the same isolated HOME/runtime to verify resume.
By default, the test-only renderer autopilot follows the Mac-only path. --manual waits for a human click-through instead.
TXT
}
while (($#)); do
  case "$1" in
    --app) app_input="${2:?missing app}"; shift 2;;
    --repeat) repeat="${2:?missing repeat}"; shift 2;;
    --kill-at) kill_at="${2:?missing phase}"; shift 2;;
    --vm-memory-gb) vm_memory_gb="${2:?missing GB}"; shift 2;;
    --keep-failures) keep_failures=1; shift;;
    --manual) manual=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo "Real-VM first-run loops require macOS." >&2; exit 2; }
[[ -n "$app_input" && "$repeat" =~ ^[1-9][0-9]*$ && "$vm_memory_gb" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
[[ -e "$app_input" ]] || { echo "Build not found: $app_input" >&2; exit 2; }

# vm_stat free + inactive + speculative pages; refuse before mounting/copying anything.
page_size=$(vm_stat | awk '/page size of/{gsub("[^0-9]","",$8); print $8}')
available_pages=$(vm_stat | awk '/Pages (free|inactive|speculative)/{gsub("\\.","",$NF); sum+=$NF} END{print sum+0}')
available_gb=$(( available_pages * page_size / 1024 / 1024 / 1024 ))
required_gb=$(( vm_memory_gb + margin_gb ))
(( available_gb >= required_gb )) || { echo "Refusing: ${available_gb} GB available; isolated VM needs ${vm_memory_gb} GB plus ${margin_gb} GB safety margin." >&2; exit 3; }

root=$(mktemp -d "${TMPDIR:-/tmp}/sulla-first-run-vm-loop.XXXXXX")
summary="$root/summary.csv"; phases="$root/phases.csv"; printf 'run,attempt,started_at,elapsed_seconds,result,kill_phase,onboarding_complete,managed_services_ready,ai_runtime_ready,home,runtime,log,failure_tail\n' > "$summary"; printf 'run,attempt,timestamp,phase,elapsed_ms,status\n' > "$phases"
mount_point=""; installed_app=""
cleanup_mount() { [[ -z "$mount_point" ]] || hdiutil detach "$mount_point" >/dev/null 2>&1 || true; }
trap cleanup_mount EXIT
if [[ "$app_input" == *.dmg ]]; then
  mount_point="$root/dmg"; mkdir "$mount_point"; hdiutil attach "$app_input" -nobrowse -mountpoint "$mount_point" >/dev/null
  source_app=$(find "$mount_point" -maxdepth 1 -name '*.app' -print -quit)
else source_app="$app_input"; fi
[[ -d "$source_app" ]] || { echo "No .app found in $app_input" >&2; exit 2; }
installed_app="$root/Sulla-first-run-test.app"; ditto "$source_app" "$installed_app"
binary=$(find "$installed_app/Contents/MacOS" -maxdepth 1 -type f -perm +111 -print -quit)
[[ -x "$binary" ]] || { echo "Packaged executable not found." >&2; exit 2; }

echo "Live Sulla stays running. Isolated test root: $root"
echo "Resource cost: a second VM reserves about ${vm_memory_gb} GB RAM plus CPU while each run is active."
record_phases() {
  local run="$1" attempt="$2" log="$3"
  awk -v run="$run" -v attempt="$attempt" '''
    /\[startup-phase\]/ {
      ts=""; phase=""; elapsed=""; status="";
      for(i=1;i<=NF;i++){if($i ~ /^[0-9]{4}-/)ts=$i; else if($i ~ /^phase=/){sub(/^phase=/,"",$i);phase=$i} else if($i ~ /^elapsedMs=/){sub(/^elapsedMs=/,"",$i);elapsed=$i} else if($i ~ /^status=/){sub(/^status=/,"",$i);status=$i}}
      if(phase!="") print run "," attempt "," ts "," phase "," elapsed "," status
    }''' "$log" >> "$phases"
}

failed=0
for run in $(seq 1 "$repeat"); do
  run_root="$root/run-$run"; home="$run_root/home"; runtime="$run_root/runtime"; logs="$run_root/logs"; mkdir -p "$home" "$runtime" "$logs"
  attempt=1; killed=0
  while :; do
    log="$logs/attempt-$attempt.log"; start_epoch=$(date +%s); started_at=$(date -u +%FT%TZ)
    autopilot=(); ((manual)) || autopilot=(SULLA_TEST_AUTOPILOT=mac-only)
    env HOME="$home" SULLA_INSTANCE=firstrun-test SULLA_RUNTIME_DIR="$runtime" SULLA_PORT_OFFSET=10000 SULLA_TEST_VM_MEMORY_GB="$vm_memory_gb" "${autopilot[@]}" \
      "$binary" --sulla-test-instance >"$log" 2>&1 & pid=$!
    if [[ -n "$kill_at" && $killed -eq 0 ]]; then
      deadline=$((SECONDS+1800))
      while kill -0 "$pid" 2>/dev/null && ((SECONDS < deadline)); do
        if grep -Fq "phase=$kill_at" "$log"; then kill "$pid"; wait "$pid" || true; killed=1; break; fi
        sleep 1
      done
      if ((killed)); then
        record_phases "$run" "$attempt" "$log"
        elapsed=$(( $(date +%s)-start_epoch )); printf '%s,%s,%s,%s,killed,%s,false,false,false,%q,%q,%q,\n' "$run" "$attempt" "$started_at" "$elapsed" "$kill_at" "$home" "$runtime" "$log" >> "$summary"
        attempt=$((attempt+1)); continue
      fi
    fi
    state="$home/Library/Application Support/sulla-desktop-firstrun-test/electron/first-run-state.json"
    deadline=$((SECONDS+3600)); completed=0; managed_ready=0; ai_ready=0; failure_reason=""
    while kill -0 "$pid" 2>/dev/null && ((SECONDS < deadline)); do
      grep -Fq 'first-run-ai-runtime-ready; aiRuntimeReady=true' "$log" && ai_ready=1
      grep -Fq 'sulla-managed-services-ready' "$log" && managed_ready=1
      if grep -Fq 'sulla-managed-services-failed' "$log"; then failure_reason="managed-services-failed"; break; fi
      if [[ -f "$state" ]] && /usr/bin/python3 - "$state" <<'PY_STATE'
import json,sys
try: raise SystemExit(0 if json.load(open(sys.argv[1])).get('onboardingComplete') is True else 1)
except Exception: raise SystemExit(1)
PY_STATE
      then completed=1; fi
      if ((completed && managed_ready && ai_ready)); then kill "$pid"; wait "$pid" || true; break; fi
      sleep 2
    done
    if [[ -n "$failure_reason" ]]; then
      kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rc=1
    elif ((completed && managed_ready && ai_ready)); then
      rc=0
    else
      if kill -0 "$pid" 2>/dev/null; then kill "$pid"; wait "$pid" 2>/dev/null || true; rc=1; else set +e; wait "$pid"; rc=$?; set -e; fi
      ((rc != 0)) && failure_reason="process-exit-$rc"
      ((SECONDS >= deadline)) && failure_reason="timeout-or-incomplete"
    fi
    # Startup emits machine-readable phase and elapsedMs fields.
    record_phases "$run" "$attempt" "$log"
    elapsed=$(( $(date +%s)-start_epoch ))
    result=pass; failure_tail=""
    if ((rc != 0)); then
      result="fail-${failure_reason:-$rc}"; failed=1
      failure_tail="$root/run-$run-attempt-$attempt-last-200.log"
      tail -n 200 "$log" > "$failure_tail"
    fi
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%q,%q,%q,%q\n' "$run" "$attempt" "$started_at" "$elapsed" "$result" "$kill_at" "$completed" "$managed_ready" "$ai_ready" "$home" "$runtime" "$log" "$failure_tail" >> "$summary"
    break
  done
  if ((failed==0 || keep_failures==0)); then rm -rf "$run_root"; else echo "Kept failed run: $run_root"; fi
done
cat "$summary"
echo "Summary: $summary"
echo "Phase timings: $phases"
if ((failed==0)); then echo "Delete all test artifacts: rm -rf '$root'"; else echo "Failures kept under $root"; exit 1; fi
