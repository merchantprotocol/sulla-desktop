#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
#
# twodev.sh — repeatable two-device QA evidence harness (acceptance checks A1–A6).
# Runs on the Mac HOST shell. Side A = this Mac (local). Side B = the iMac over ssh.
# The sulla CLI only exists inside each Desktop's VM, so every sulla call goes
# through sulla-runtime exec. See README.md for env vars and what PASS means.
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

TWODEV_OUT="${TWODEV_OUT:-$HOME/Sites/sulla/_wt/twodev-evidence}"
IMAC_HOST="${TWODEV_IMAC_HOST:-Jonathons-iMac.local}"
APP_PATH="${TWODEV_APP_PATH:-/Applications/Sulla Desktop.app}"
FILES_FOLDER="${TWODEV_FOLDER:-Projects/sulla-desktop/qa/two-device}"
ORG="${TWODEV_ORG:-}"
EVIDENCE_LOG="$TWODEV_OUT/evidence-$(date -u +%Y-%m-%d).jsonl"

# Locates sulla-runtime on whichever machine runs it, then execs it with "$@".
# Passed to `bash -s -- <args>` on stdin, so no quoting of the snippet is needed.
readonly RUNTIME_SNIPPET='
RT="$(command -v sulla-runtime 2>/dev/null || true)"
if [ -z "$RT" ]; then
  RT="/Applications/Sulla Desktop.app/Contents/Resources/resources/darwin/sulla-runtime/sulla-runtime"
fi
if [ ! -x "$RT" ]; then
  echo "twodev: sulla-runtime not found on PATH or in Sulla Desktop.app" >&2
  exit 127
fi
exec "$RT" exec -- "$@"
'

die() {
  echo "twodev: $*" >&2
  exit 2
}

need_cmds() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing required command: $c"
  done
}

require_env() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "env $name is required for this step (see README.md)"
  done
}

# run_on <a|b> <argv...>: run argv inside that side's Desktop VM via sulla-runtime.
run_on() {
  local side="$1"
  shift
  case "$side" in
    a) printf '%s\n' "$RUNTIME_SNIPPET" | bash -s -- "$@" ;;
    b)
      local quoted="" arg
      for arg in "$@"; do
        quoted+=" $(printf '%q' "$arg")"
      done
      printf '%s\n' "$RUNTIME_SNIPPET" | ssh -o BatchMode=yes "$IMAC_HOST" "bash -s --$quoted"
      ;;
    *) die "side must be a or b, got: $side" ;;
  esac
}

# host_on <a|b> <fixed-command>: run a fixed host-level command (no user input) on that Mac.
host_on() {
  local side="$1" cmd="$2"
  case "$side" in
    a) bash -c "$cmd" ;;
    b) ssh -o BatchMode=yes "$IMAC_HOST" "$cmd" ;;
    *) die "side must be a or b, got: $side" ;;
  esac
}

# Builds a JSON object from key/value argument pairs (quoting-safe).
json_obj() {
  python3 -I -c '
import json, sys
args = sys.argv[1:]
print(json.dumps({args[i]: args[i + 1] for i in range(0, len(args), 2)}, sort_keys=True))
' "$@"
}

# Directory args: {} or {"org": "<ORG>"} when TWODEV_ORG is set.
directory_json() {
  if [ -n "$ORG" ]; then
    json_obj org "$ORG"
  else
    printf '%s\n' '{}'
  fi
}

# Reads sulla output on stdin and prints a JSON object of known ids found anywhere in it.
# Extra key=value arguments are merged in (for example nonce=...). Token-like fields are never read.
extract_ids() {
  python3 -I -c '
import json, sys
wanted = {"userId": "userId", "orgId": "orgId", "teamId": "teamId",
          "conversationId": "conversationId", "messageId": "messageId",
          "fileId": "fileId", "file_id": "fileId", "agentId": "agentId"}
found = {}

def walk(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in wanted and isinstance(value, (str, int)) and wanted[key] not in found:
                found[wanted[key]] = str(value)
            walk(value)
    elif isinstance(node, list):
        for item in node:
            walk(item)
    elif isinstance(node, str) and node.lstrip()[:1] in ("{", "["):
        # sulla wraps results as JSON-in-a-string; decode and keep walking.
        try:
            walk(json.loads(node))
        except ValueError:
            pass

try:
    walk(json.loads(sys.stdin.read()))
except ValueError:
    pass
for pair in sys.argv[1:]:
    key, _, value = pair.partition("=")
    found[key] = value
print(json.dumps(found, sort_keys=True))
' "$@"
}

# log_evidence <check> <machine> <command-label> <exit-code> <ids-json>
# Appends one JSON line. Never receives tokens, emails, phones or message bodies.
log_evidence() {
  mkdir -p "$TWODEV_OUT"
  python3 -I -c '
import datetime, json, sys
path, check, machine, command, code, ids = sys.argv[1:7]
record = {
    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "check": check,
    "machine": machine,
    "command": command,
    "exit": int(code),
    "ids": json.loads(ids),
}
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
' "$EVIDENCE_LOG" "$1" "$2" "$3" "$4" "$5"
}

machine_label() {
  case "$1" in
    a) echo "A-mac" ;;
    b) echo "B-imac" ;;
  esac
}

# sulla_call <side> <check> <category/tool> <json> [extra-id key=value...]
# Runs one sulla command on a side, prints its raw output to stdout only for the
# caller to parse, logs the evidence line, and returns the exit code.
sulla_call() {
  local side="$1" check="$2" tool="$3" json="$4"
  shift 4
  local out="" code=0 ids
  out="$(run_on "$side" sulla "$tool" "$json" 2>&1)" || code=$?
  ids="$(printf '%s' "$out" | extract_ids "$@")"
  log_evidence "$check" "$(machine_label "$side")" "sulla $tool" "$code" "$ids"
  printf '%s' "$out"
  return "$code"
}

# ---------------------------------------------------------------- inventory

cmd_inventory() {
  need_cmds ssh python3
  local side version team uptime_line dir_out dir_code=0 ids
  for side in a b; do
    echo "== $(machine_label "$side") =="
    version="$(host_on "$side" "/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' $(printf '%q' "$APP_PATH/Contents/Info.plist")" 2>/dev/null || echo unknown)"
    echo "app version: $version"
    team="$(host_on "$side" "codesign -dv --verbose=4 $(printf '%q' "$APP_PATH") 2>&1 | grep '^TeamIdentifier' || echo 'TeamIdentifier not found'" || true)"
    echo "codesign: $team"
    uptime_line="$(host_on "$side" 'uptime' || echo unknown)"
    echo "uptime: $uptime_line"
    log_evidence inventory "$(machine_label "$side")" "app-version+codesign+uptime" 0 \
      "$(json_obj version "$version")"

    dir_out="$(sulla_call "$side" inventory org/directory "$(directory_json)" 2>&1)" || dir_code=$?
    if [ "$dir_code" -eq 0 ]; then
      echo "org/directory: ok (raw output not printed: may contain personal data)"
    else
      echo "org/directory: FAILED exit $dir_code"
    fi
    dir_code=0
  done
}

# ---------------------------------------------------------------- A1

cmd_a1() {
  require_env A_USER B_USER
  need_cmds python3 ssh
  local out_a out_b code_a=0 code_b=0 pass=1
  out_a="$(sulla_call a a1 org/directory "$(directory_json)" 2>&1)" || code_a=$?
  out_b="$(sulla_call b a1 org/directory "$(directory_json)" 2>&1)" || code_b=$?

  if [ "$code_a" -eq 0 ] && printf '%s' "$out_a" | grep -F -q -- "$B_USER"; then
    echo "A1 PASS: A's directory lists B's userId"
  else
    echo "A1 FAIL: A's directory (exit $code_a) does not list B's userId"
    pass=0
  fi
  if [ "$code_b" -eq 0 ] && printf '%s' "$out_b" | grep -F -q -- "$A_USER"; then
    echo "A1 PASS: B's directory lists A's userId"
  else
    echo "A1 FAIL: B's directory (exit $code_b) does not list A's userId"
    pass=0
  fi
  if [ "$pass" -eq 1 ]; then
    echo "A1 RESULT: PASS"
    return 0
  fi
  echo "A1 RESULT: FAIL"
  return 1
}

# ---------------------------------------------------------------- A2

new_nonce() {
  if [ -n "${TWODEV_NONCE:-}" ]; then
    printf '%s' "$TWODEV_NONCE"
  else
    printf 'twodev-%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  fi
}

cmd_a2_send() {
  require_env A_USER B_USER B_AGENT_ID
  need_cmds python3
  local nonce conversation code=0 msg json out
  nonce="$(new_nonce)"
  conversation="${TWODEV_CONVERSATION_ID:-}"
  if [ -z "$conversation" ]; then
    # Fall back to the conversationId the directory exposes on A.
    out="$(sulla_call a a2-send org/directory "$(directory_json)" 2>&1)" || true
    conversation="$(printf '%s' "$out" | extract_ids | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("conversationId",""))')"
  fi
  [ -n "$conversation" ] || die "set TWODEV_CONVERSATION_ID (no conversationId found in A's directory)"

  msg="QA two-device A2 check. Nonce ${nonce}. Reply with the nonce."
  json="$(json_obj conversationId "$conversation" recipientUserId "$B_USER" recipientAgentId "$B_AGENT_ID" message "$msg")"
  out="$(sulla_call a a2-send org/send_message "$json" nonce="$nonce" 2>&1)" || code=$?
  if [ "$code" -eq 0 ]; then
    echo "A2-send sent: nonce=$nonce (message body not printed)"
    echo "A2-send RESULT: SENT (verify delivery with: $SCRIPT_NAME a2-check)"
  else
    echo "A2-send RESULT: FAIL exit $code"
    return 1
  fi
  printf '%s\n' "$nonce" >"$TWODEV_OUT/last-a2-nonce.txt"
}

cmd_a2_check() {
  need_cmds python3
  local nonce="" out code=0 team
  if [ -n "${TWODEV_NONCE:-}" ]; then
    nonce="$TWODEV_NONCE"
  elif [ -f "$TWODEV_OUT/last-a2-nonce.txt" ]; then
    nonce="$(cat "$TWODEV_OUT/last-a2-nonce.txt")"
  fi
  out="$(sulla_call b a2-check org/directory "$(directory_json)" 2>&1)" || code=$?
  team="$(printf '%s' "$out" | extract_ids | python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("teamId", "<teamId>"))')"
  echo "A2-check: B's org/directory exit $code (raw output not printed)."
  echo "A2-check: no B-side inbox/thread read tool was verified in the sulla catalog."
  echo "A2-check: MANUAL — confirm nonce ${nonce:-<unset>} in the Cloud thread via GET /orgs/${team}/inbox"
  echo "A2-check RESULT: MANUAL (not PASS until a human or the endpoint shows the nonce on B)"
  log_evidence a2-check B-imac "manual inbox check" 0 "$(json_obj nonce "${nonce:-none}")"
  return 0
}

# ---------------------------------------------------------------- A4

cmd_a4() {
  local side="${1:-}" nonce fname content dir code=0 out
  case "$side" in a | b) ;; *) die "usage: $SCRIPT_NAME a4 <a|b>" ;; esac
  need_cmds python3
  nonce="$(new_nonce)"
  fname="twodev-a4-${side}-${nonce}.md"
  dir="/mnt/sulla-files/$FILES_FOLDER"
  content="# Two-device A4 evidence ($(machine_label "$side"))

Nonce: ${nonce}
Written by scripts/qa/two-device/twodev.sh.
"

  run_on "$side" sh -c 'set -eu; mkdir -p "$1"; printf "%s" "$2" > "$1/$3"; test -s "$1/$3"' _ "$dir" "$content" "$fname" 2>&1 \
    || die "write failed on $(machine_label "$side") (sh -c exited non-zero)"
  log_evidence a4-write "$(machine_label "$side")" "sh -c write file" 0 "$(json_obj file "$fname" nonce "$nonce")"

  # Files indexing can lag a few seconds; retry the search a few times.
  local attempt
  for attempt in 1 2 3 4; do
    out="$(sulla_call "$side" a4-search files/search "$(json_obj query "$fname")" nonce="$nonce" 2>&1)" || code=$?
    if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -F -q -- "$fname"; then
      echo "A4 PASS: $fname is findable in $(machine_label "$side") File Manager search"
      echo "A4 RESULT: PASS (screenshot the File Manager on $(machine_label "$side") for the proof report)"
      return 0
    fi
    code=0
    sleep 5
  done
  echo "A4 FAIL: $fname not found by files/search on $(machine_label "$side") after 4 tries"
  echo "A4 RESULT: FAIL"
  return 1
}

# ---------------------------------------------------------------- placeholders

cmd_todo() {
  local check="$1" reason="$2"
  echo "$check RESULT: TODO — $reason"
  log_evidence "$check" both "not run" 2 "{}"
  return 2
}

usage() {
  cat <<USAGE
Usage: $SCRIPT_NAME <step>

Steps:
  inventory          app version, codesign team id, uptime and directory call on both Macs
  a1                 each side's org/directory lists the other user (needs A_USER, B_USER)
  a2-send            A sends a nonce message to B's agent (needs A_USER, B_USER, B_AGENT_ID)
  a2-check           B-side thread check (manual endpoint note; see README)
  a4 <a|b>           write an AI-created file on one side and confirm File Manager search
  a5                 TODO (org sharing not built)
  a6                 TODO (org sharing not built)

Evidence is appended to \$TWODEV_OUT/evidence-<date>.jsonl.
USAGE
}

main() {
  need_cmds bash
  local step="${1:-}"
  case "$step" in
    inventory) cmd_inventory ;;
    a1) cmd_a1 ;;
    a2-send) cmd_a2_send ;;
    a2-check) cmd_a2_check ;;
    a4) shift; cmd_a4 "${1:-}" ;;
    a5) cmd_todo A5 "org sharing from A to the org is not built yet" ;;
    a6) cmd_todo A6 "org shared folder across Desktops is not built yet" ;;
    -h | --help | help | "") usage ;;
    *) usage >&2; die "unknown step: $step" ;;
  esac
}

main "$@"
