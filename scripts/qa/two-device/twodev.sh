#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
#
# twodev.sh — repeatable two-device QA evidence harness (acceptance checks A1–A6).
# Runs on the Mac HOST shell. Side A = this Mac (local). Side B = the iMac over ssh.
# The sulla CLI does not exist on the host or in the Desktop VM, so every sulla
# action is run by that Desktop's own agent through its local chat API
# (127.0.0.1:3000). See README.md for env vars and what PASS means.
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

TWODEV_OUT="${TWODEV_OUT:-$HOME/Sites/sulla/_wt/twodev-evidence}"
IMAC_HOST="${TWODEV_IMAC_HOST:-Jonathons-iMac.local}"
APP_PATH="${TWODEV_APP_PATH:-/Applications/Sulla Desktop.app}"
# Host binary that runs commands inside each Mac's Sulla VM (same path the Desktop terminal uses).
RUNTIME_BIN="${TWODEV_RUNTIME_BIN:-$APP_PATH/Contents/Resources/resources/darwin/sulla-runtime/sulla-runtime}"
FILES_FOLDER="${TWODEV_FOLDER:-Projects/sulla-desktop/qa/two-device}"
ORG="${TWODEV_ORG:-}"
# A6 peer wait: one push (~10s) plus one peer pull (~60s) can exceed a minute.
A6_WAIT="${TWODEV_A6_WAIT:-180}"
AGENT_MODEL="${TWODEV_AGENT:-sulla-desktop}"
EVIDENCE_LOG="$TWODEV_OUT/evidence-$(date -u +%Y-%m-%d).jsonl"

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

# Remote body: runs on the Mac that owns the Desktop (side A locally, side B over ssh).
# It reads the prompt from TWODEV_PROMPT_B64 (set by the header lines), reads the
# chat API token from the local token file inside this shell, POSTs one non-streaming
# chat completion and prints only the assistant text. The token is never printed,
# logged or put on a command line; it stays in this Python process's memory.
# Quoted heredoc, so nothing here is expanded by the caller.
emit_ask_script() {
  printf "TWODEV_PROMPT_B64='%s'\nTWODEV_MODEL='%s'\nexport TWODEV_PROMPT_B64 TWODEV_MODEL\n" "$1" "$2"
  cat <<'REMOTE_BODY'
python3 -I - <<'PYEOF'
import base64, json, os, sys, urllib.error, urllib.request

def fail(message):
    sys.stderr.write("twodev: " + message + "\n")
    sys.exit(1)

token_path = os.path.join(os.path.expanduser("~"), "Library", "Application Support",
                          "sulla-desktop", "chat-api-token.json")
try:
    with open(token_path, encoding="utf-8") as handle:
        token = json.load(handle).get("token", "")
except Exception:
    fail("chat API token file unreadable")
if not isinstance(token, str) or not token:
    fail("chat API token missing")

prompt = base64.b64decode(os.environ["TWODEV_PROMPT_B64"]).decode("utf-8")
payload = json.dumps({
    "model": os.environ["TWODEV_MODEL"],
    "stream": False,
    "sulla": {"run_as_owner": True},
    "messages": [{"role": "user", "content": prompt}],
}).encode("utf-8")
request = urllib.request.Request(
    "http://127.0.0.1:3000/v1/chat/completions", data=payload, method="POST",
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
# No proxies: this is a loopback call to the local Desktop API.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(request, timeout=600) as response:
        reply = json.loads(response.read().decode("utf-8"))
except urllib.error.HTTPError as error:
    fail("chat API returned HTTP %d" % error.code)
except Exception:
    fail("chat API request failed")

try:
    content = reply["choices"][0]["message"]["content"]
except Exception:
    fail("chat API reply had no assistant text")
sys.stdout.write(content if isinstance(content, str) else json.dumps(content))
PYEOF
REMOTE_BODY
}

# ask_agent <a|b> <prompt>: run one prompt on that Mac's Desktop agent and print its text.
# The prompt travels on stdin as base64 inside the script body, never on argv.
ask_agent() {
  local side="$1" prompt="$2" b64
  [[ "$AGENT_MODEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "TWODEV_AGENT has unsupported characters"
  b64="$(printf '%s' "$prompt" | base64 | tr -d '\n')"
  case "$side" in
    a) emit_ask_script "$b64" "$AGENT_MODEL" | bash -s ;;
    b) emit_ask_script "$b64" "$AGENT_MODEL" | ssh -o BatchMode=yes "$IMAC_HOST" 'bash -s' ;;
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

# guest_start <a|b> <host-out-file> <guest-command>: runs one shell command inside that Mac's
# Sulla VM, where /mnt/sulla-files is mounted, through sulla-runtime exec (the Desktop terminal's
# own path). It starts detached with stdin from /dev/null, because attached over ssh it hangs.
# It returns at once. The host out file gets __TWODEV_RC=<exit> when the guest command ends.
guest_start() {
  local side="$1" out="$2" cmd="$3" wrapped
  wrapped="$cmd; echo __TWODEV_RC=\$?"
  host_on "$side" "rm -f $(printf '%q' "$out"); nohup $(printf '%q' "$RUNTIME_BIN") exec -- sh -lc $(printf '%q' "$wrapped") </dev/null >$(printf '%q' "$out") 2>&1 &"
}

# guest_wait <a|b> <host-out-file> <seconds>: polls the out file until the guest command ends.
# Prints the guest exit code and returns 0, or returns 1 when the limit passes first.
guest_wait() {
  local side="$1" out="$2" limit="$3" waited=0 rc=""
  while [ "$waited" -lt "$limit" ]; do
    rc="$(host_on "$side" "grep -h '^__TWODEV_RC=' $(printf '%q' "$out") 2>/dev/null | tail -1 | cut -d= -f2" || true)"
    if [ -n "$rc" ]; then
      printf '%s' "$rc"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# guest_cleanup <a|b> <host-out-file>: removes the temporary out file on that Mac.
guest_cleanup() {
  host_on "$1" "rm -f $(printf '%q' "$2")" || true
}

# Builds a JSON object from key/value argument pairs (quoting-safe).
json_obj() {
  python3 -I -c '
import json, sys
args = sys.argv[1:]
print(json.dumps({args[i]: args[i + 1] for i in range(0, len(args), 2)}, sort_keys=True))
' "$@"
}

# Parses the agent's reply on stdin. Takes the first complete JSON object in the text,
# walks it for ids, and prints {"ok","found","error","evidence"}. Only ids, userIds,
# agentIds and flags go into evidence. Extra key=value args (for example nonce=...) merge in.
readonly PARSE_PY='
import json, os, re, sys
text = sys.stdin.read()
transport = int(sys.argv[1]) if len(sys.argv) > 1 else 0
mode = os.environ.get("TWODEV_MODE", "json")
try:
    extra = json.loads(os.environ.get("TWODEV_EXTRA_JSON") or "{}")
except ValueError:
    extra = {}

SIGNIN = re.compile(r"sign-in expired|reconnect in settings", re.I)
RATE = re.compile(r"rate.?limit|too many requests|\b429\b", re.I)
TIMED_OUT = re.compile(r"timed? ?out", re.I)
REDACTIONS = [
    (re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "[email]"),
    (re.compile(r"(?i)bearer\s+\S+"), "[token]"),
    (re.compile(r"[A-Za-z0-9_.-]{20,}"), "[token]"),
    (re.compile(r"\+?\d[\d\s().-]{7,}\d"), "[phone]"),
]

def classify(message):
    if SIGNIN.search(message):
        return "model_signin_expired"
    if RATE.search(message):
        return "rate_limited"
    if TIMED_OUT.search(message):
        return "timeout"
    return None

def snippet(message):
    out = " ".join(message.split())
    for pattern, label in REDACTIONS:
        out = pattern.sub(label, out)
    return out[:160]

def finish(ok, error, found, evidence, shown, log):
    print(json.dumps({"ok": ok, "found": found, "error": error,
                      "snippet": shown, "evidence": evidence, "log": log}, sort_keys=True))
    sys.exit(0)

def fail(error, shown="", found=None):
    finish(False, error, found, {}, shown, {"ok": False, "error": error})

if transport != 0:
    fail("transport_failed")

if mode == "pong":
    reason = classify(text)
    if reason:
        fail(reason, snippet(text))
    if re.search(r"\bPONG\b", text):
        finish(True, None, None, {}, "", {"ok": True})
    fail("no_pong_reply", snippet(text))

decoder = json.JSONDecoder()
obj = None
pos = text.find("{")
while pos != -1 and obj is None:
    try:
        candidate, _ = decoder.raw_decode(text, pos)
        if isinstance(candidate, dict):
            obj = candidate
    except ValueError:
        pass
    pos = text.find("{", pos + 1)

if obj is None:
    fail(classify(text) or "no_json_reply", snippet(text))

SCALAR = ("orgId", "teamId", "conversationId", "messageId", "fileId", "collectionId")
ids, user_ids, agent_ids = {}, [], []

def walk(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "userId" and isinstance(value, str):
                if value not in user_ids:
                    user_ids.append(value)
            elif key == "agentId" and isinstance(value, str):
                if value not in agent_ids:
                    agent_ids.append(value)
            elif key in SCALAR and isinstance(value, (str, int)) and key not in ids:
                ids[key] = str(value)
            walk(value)
    elif isinstance(node, list):
        for item in node:
            walk(item)

walk(obj)
found = obj.get("found") if isinstance(obj.get("found"), bool) else None
evidence = dict(ids)
evidence["userIds"] = user_ids
evidence["agentIds"] = agent_ids
if found is not None:
    evidence["found"] = found
reported_hash = obj.get("sha256")
if isinstance(reported_hash, str) and re.fullmatch(r"[0-9a-f]{64}", reported_hash):
    evidence["sha256"] = reported_hash
    extra["sha256"] = reported_hash
for key, value in extra.items():
    evidence[key] = value

if obj.get("ok") is not True:
    agent_error = obj.get("error") if isinstance(obj.get("error"), str) else ""
    reason = classify(agent_error) or classify(text) or "agent_reported_error"
    fail(reason, snippet(agent_error or text), found)
finish(True, None, found, evidence, "", {key: value for key, value in evidence.items() if key != "sha256"})
'

# json_field <json> <dotted.path>: print one field ("" when missing; JSON for lists/objects/bools).
readonly JSON_FIELD_PY='
import json, sys
value = json.loads(sys.argv[1])
for key in sys.argv[2].split("."):
    value = value.get(key) if isinstance(value, dict) else None
if value is None:
    print("")
elif isinstance(value, str):
    print(value)
else:
    print(json.dumps(value, sort_keys=True))
'
json_field() {
  [ -n "$1" ] || { echo ""; return 0; }
  python3 -I -c "$JSON_FIELD_PY" "$1" "$2"
}

# pairs_json <key=value>...: validates evidence pairs and prints them as one JSON object.
# Keys are lowerCamel words and values are short ids or flags, so free text cannot get in.
pairs_json() {
  python3 -I -c '
import json, re, sys
out = {}
for arg in sys.argv[1:]:
    key, sep, value = arg.partition("=")
    if not sep or not re.fullmatch(r"[a-z][A-Za-z0-9]{0,31}", key) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value):
        sys.exit("twodev: internal error: evidence pair rejected")
    out[key] = value
print(json.dumps(out, sort_keys=True))
' "$@"
}

# report_failure <a|b> <machine-reason> <sanitized-snippet>: operator-only message on stderr.
report_failure() {
  local side="$1" reason="$2" shown="$3"
  echo "$(machine_label "$side") agent call failed: ${reason:-unknown}" >&2
  if [ -n "$shown" ]; then
    echo "  agent said: $shown" >&2
  fi
}

# agent_call <a|b> <check> <command-label> <prompt> [key=value...]
# Runs one prompt on that side's agent and parses its JSON reply. Only validated key=value
# pairs reach the evidence log, and the prompt never does. A failure logs only
# {"ok":false,"error":"<machine reason>"}. Prints the parsed object to stdout and returns 0
# only when the agent reported ok:true.
agent_call() {
  local side="$1" check="$2" label="$3" prompt="$4"
  local raw="" code=0 parsed ok extra
  shift 4
  extra="$(pairs_json "$@")"
  echo "waiting on $(machine_label "$side") agent…" >&2
  raw="$(ask_agent "$side" "$prompt")" || code=$?
  parsed="$(printf '%s' "$raw" | TWODEV_MODE=json TWODEV_EXTRA_JSON="$extra" python3 -I -c "$PARSE_PY" "$code")"
  ok="$(json_field "$parsed" ok)"
  if [ "$ok" != "true" ]; then
    if [ "$code" -eq 0 ]; then
      code=1
    fi
    report_failure "$side" "$(json_field "$parsed" error)" "$(json_field "$parsed" snippet)"
  fi
  log_evidence "$check" "$(machine_label "$side")" "$label" "$code" "$(json_field "$parsed" log)"
  printf '%s\n' "$parsed"
  return "$code"
}

# preflight_side <a|b>: one PONG round trip to that side's agent. Prints PASS or FAIL with a reason.
preflight_side() {
  local side="$1" raw="" code=0 parsed ok
  echo "waiting on $(machine_label "$side") agent… (preflight)" >&2
  raw="$(ask_agent "$side" "Reply with exactly: PONG")" || code=$?
  parsed="$(printf '%s' "$raw" | TWODEV_MODE=pong TWODEV_EXTRA_JSON='{}' python3 -I -c "$PARSE_PY" "$code")"
  ok="$(json_field "$parsed" ok)"
  log_evidence preflight "$(machine_label "$side")" "preflight-pong" "$([ "$ok" = "true" ] && echo 0 || echo 1)" "$(json_field "$parsed" log)"
  if [ "$ok" = "true" ]; then
    echo "preflight $(machine_label "$side"): PASS (agent replied PONG)"
    return 0
  fi
  echo "preflight $(machine_label "$side"): FAIL ($(json_field "$parsed" error))"
  local shown
  shown="$(json_field "$parsed" snippet)"
  if [ -n "$shown" ]; then
    echo "  agent said: $shown" >&2
  fi
  return 1
}

# require_preflight <a|b>...: stops the whole step (exit 1) before any QA call on a failing side.
require_preflight() {
  local side
  for side in "$@"; do
    if ! preflight_side "$side"; then
      echo "twodev: stopping before any QA call: $(machine_label "$side") agent failed preflight" >&2
      exit 1
    fi
  done
}

cmd_preflight() {
  need_cmds python3 ssh
  local side rc=0
  for side in a b; do
    preflight_side "$side" || rc=1
  done
  if [ "$rc" -eq 0 ]; then
    echo "PREFLIGHT RESULT: PASS"
  else
    echo "PREFLIGHT RESULT: FAIL"
  fi
  return "$rc"
}

# has_user <parsed-json> <userId>: exit 0 when the reply lists that userId.
has_user() {
  json_field "$1" evidence.userIds | python3 -I -c '
import json, sys
raw = sys.stdin.read().strip()
ids = json.loads(raw) if raw else []
sys.exit(0 if sys.argv[1] in ids else 1)
' "$2"
}

# Directory args: {} or {"org": "<ORG>"} when TWODEV_ORG is set.
directory_args() {
  if [ -n "$ORG" ]; then
    json_obj org "$ORG"
  else
    printf '%s\n' '{}'
  fi
}

directory_prompt() {
  printf '%s' "Read-only QA check. Run exactly one sulla tool: org/directory with arguments $(directory_args). Do not run any other tool and do not change anything. Then reply with ONLY one JSON object, no prose and no code fences: {\"ok\":true or false,\"error\":null or a short reason,\"orgId\":\"<id or null>\",\"conversationId\":\"<id or null>\",\"members\":[{\"userId\":\"<id>\",\"agentId\":\"<id or null>\"}]}. Include ids only. Never include names, emails, phone numbers, tokens or message bodies."
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
    "ids": json.loads(ids or "{}"),
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

new_nonce() {
  if [ -n "${TWODEV_NONCE:-}" ]; then
    printf '%s' "$TWODEV_NONCE"
  else
    printf 'twodev-%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  fi
}

# ---------------------------------------------------------------- inventory

cmd_inventory() {
  need_cmds ssh python3
  require_preflight a b
  local side version team uptime_line parsed code
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

    code=0
    parsed="$(agent_call "$side" inventory org-directory "org/directory" "$(directory_prompt)")" || code=$?
    if [ "$code" -eq 0 ]; then
      echo "org/directory: ok (reply not printed: ids only in evidence log)"
    else
      echo "org/directory: FAILED exit $code"
    fi
  done
}

# ---------------------------------------------------------------- A1

cmd_a1() {
  require_env A_USER B_USER
  need_cmds python3
  require_preflight a b
  local pa pb ca=0 cb=0 pass=1
  pa="$(agent_call a a1 org-directory "org/directory" "$(directory_prompt)")" || ca=$?
  pb="$(agent_call b a1 org-directory "org/directory" "$(directory_prompt)")" || cb=$?

  if [ "$ca" -eq 0 ] && has_user "$pa" "$B_USER"; then
    echo "A1 PASS: A's directory lists B's userId"
  else
    echo "A1 FAIL: A's directory (exit $ca) does not list B's userId"
    pass=0
  fi
  if [ "$cb" -eq 0 ] && has_user "$pb" "$A_USER"; then
    echo "A1 PASS: B's directory lists A's userId"
  else
    echo "A1 FAIL: B's directory (exit $cb) does not list A's userId"
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

cmd_a2_send() {
  require_env A_USER B_USER B_AGENT_ID
  need_cmds python3
  require_preflight a
  local nonce conversation code=0 parsed msg args prompt
  nonce="$(new_nonce)"
  conversation="${TWODEV_CONVERSATION_ID:-}"
  if [ -z "$conversation" ]; then
    # Fall back to the conversationId A's directory exposes.
    parsed="$(agent_call a a2-send org-directory "org/directory" "$(directory_prompt)")" || true
    conversation="$(json_field "$parsed" evidence.conversationId)"
  fi
  [ -n "$conversation" ] || die "set TWODEV_CONVERSATION_ID (no conversationId found in A's directory)"

  msg="QA two-device A2 check. Nonce ${nonce}. Reply with the nonce."
  args="$(json_obj conversationId "$conversation" recipientUserId "$B_USER" recipientAgentId "$B_AGENT_ID" message "$msg")"
  prompt="Run exactly one sulla tool: org/send_message with arguments ${args}. Do not run any other tool. Then reply with ONLY one JSON object, no prose and no code fences: {\"ok\":true or false,\"error\":null or a short reason,\"conversationId\":\"<id>\",\"messageId\":\"<id>\"}."
  parsed="$(agent_call a a2-send send-message "org/send_message" "$prompt" nonce="$nonce")" || code=$?
  if [ "$code" -ne 0 ]; then
    echo "A2-send RESULT: FAIL (agent did not report ok)"
    return 1
  fi
  echo "A2-send sent: nonce=$nonce (message body not printed)"
  echo "A2-send RESULT: SENT (verify delivery with: $SCRIPT_NAME a2-check, then $SCRIPT_NAME a2-reply)"
  json_obj conversationId "$conversation" nonce "$nonce" >"$TWODEV_OUT/last-a2.json"
}

# a2-reply: B's agent replies in the same conversation with the nonce.
cmd_a2_reply() {
  need_cmds python3
  local nonce conversation="" code=0 parsed args prompt
  if [ -f "$TWODEV_OUT/last-a2.json" ]; then
    conversation="$(json_field "$(cat "$TWODEV_OUT/last-a2.json")" conversationId)"
    nonce="$(json_field "$(cat "$TWODEV_OUT/last-a2.json")" nonce)"
  fi
  conversation="${TWODEV_CONVERSATION_ID:-$conversation}"
  nonce="${TWODEV_NONCE:-${nonce:-}}"
  [ -n "$conversation" ] && [ -n "$nonce" ] || die "run a2-send first, or set TWODEV_CONVERSATION_ID and TWODEV_NONCE"

  require_preflight b
  args="$(json_obj conversationId "$conversation" message "QA two-device A2 reply. Received nonce ${nonce}.")"
  prompt="Run exactly one sulla tool: org/send_message with arguments ${args}. Do not run any other tool. Then reply with ONLY one JSON object, no prose and no code fences: {\"ok\":true or false,\"error\":null or a short reason,\"conversationId\":\"<id>\",\"messageId\":\"<id>\"}."
  parsed="$(agent_call b a2-reply send-message "org/send_message" "$prompt" nonce="$nonce")" || code=$?
  if [ "$code" -eq 0 ]; then
    echo "A2-reply RESULT: SENT by B (verify on both Cloud threads)"
    return 0
  fi
  echo "A2-reply RESULT: FAIL (B's agent did not report ok)"
  return 1
}

cmd_a2_check() {
  need_cmds python3
  local nonce="" code=0 parsed found prompt
  if [ -n "${TWODEV_NONCE:-}" ]; then
    nonce="$TWODEV_NONCE"
  elif [ -f "$TWODEV_OUT/last-a2.json" ]; then
    nonce="$(json_field "$(cat "$TWODEV_OUT/last-a2.json")" nonce)"
  fi
  nonce="${nonce:-none}"

  require_preflight b
  prompt="Read-only QA check. Using your org tools, look at this Desktop's org inbox and pending contact or conversation requests for a message whose text contains the exact nonce ${nonce}. Do not reply, send or change anything. Stop after one read per tool. Then reply with ONLY one JSON object, no prose and no code fences: {\"ok\":true or false,\"error\":null or a short reason,\"found\":true or false or null,\"conversationId\":\"<id or null>\",\"messageId\":\"<id or null>\"}. Use found null and error \"no inbox tool\" if no sulla tool can read the inbox. Include ids only; never include message bodies."
  parsed="$(agent_call b a2-check inbox-read "org inbox read" "$prompt" nonce="$nonce")" || code=$?
  found="$(json_field "$parsed" found)"
  if [ "$code" -eq 0 ] && [ "$found" = "true" ]; then
    echo "A2-check: B's agent reports the nonce in its inbox (agent-reported; confirm on B's Cloud thread)"
    echo "A2-check RESULT: AGENT-REPORTED-FOUND (not PASS until a human sees the reply on both sides)"
  else
    echo "A2-check: no sulla tool confirmed the nonce on B. Check B's Cloud thread by hand for nonce ${nonce}."
    echo "A2-check RESULT: MANUAL"
  fi
  return 0
}

# ---------------------------------------------------------------- A4

cmd_a4() {
  local side="${1:-}" nonce fname content dir attempt parsed found prompt search_args
  case "$side" in a | b) ;; *) die "usage: $SCRIPT_NAME a4 <a|b>" ;; esac
  need_cmds python3
  require_preflight "$side"
  nonce="$(new_nonce)"
  fname="twodev-a4-${side}-${nonce}.md"
  dir="/mnt/sulla-files/$FILES_FOLDER"
  content="Two-device A4 evidence ($(machine_label "$side")). Nonce: ${nonce}. Written by scripts/qa/two-device/twodev.sh."
  search_args="$(json_obj query "$fname")"

  # Files indexing can lag a few seconds; the first try writes the file, later tries only search.
  for attempt in 1 2 3 4; do
    if [ "$attempt" -eq 1 ]; then
      prompt="Two-device QA check A4 on this Desktop. Step 1: with your write_file tool, create ${dir}/${fname} with exactly this text: ${content} Step 2: run exactly one sulla tool: files/search with arguments ${search_args}. Do not run any other tool. Reply with ONLY one JSON object, no prose and no code fences: {\"ok\":true or false,\"error\":null or a short reason,\"found\":true or false,\"fileId\":\"<id or null>\"}."
    else
      prompt="Read-only QA check. Run exactly one sulla tool: files/search with arguments ${search_args}. Do not run any other tool. Reply with ONLY one JSON object, no prose and no code fences: {\"ok\":true or false,\"error\":null or a short reason,\"found\":true or false,\"fileId\":\"<id or null>\"}."
    fi
    parsed="$(agent_call "$side" "a4-search-$attempt" files/search "$prompt" nonce="$nonce" file="$fname")" || true
    found="$(json_field "$parsed" found)"
    if [ "$found" = "true" ]; then
      echo "A4 PASS: $fname is findable in $(machine_label "$side") File Manager search"
      echo "A4 RESULT: PASS (screenshot the File Manager on $(machine_label "$side") for the proof report)"
      return 0
    fi
    sleep 5
  done
  echo "A4 FAIL: $fname not found by files/search on $(machine_label "$side") after 4 tries"
  echo "A4 RESULT: FAIL"
  return 1
}

# ---------------------------------------------------------------- A5 / A6

# Setup is deliberately idempotent: Desktop returns the existing org collection by name.
cmd_a5_setup() {
  require_env ORG
  require_preflight a
  local args prompt parsed code=0 id
  args="$(json_obj orgId "$ORG")"
  prompt="Run exactly one sulla tool: files/list_shared with arguments ${args}. Find a collection named twodev-proof and reply only JSON {\"ok\":true,\"collectionId\":\"id\"} if found; otherwise {\"ok\":true,\"found\":false}."
  parsed="$(agent_call a a5-setup find-proof-collection files/list_shared "$prompt")" || code=$?
  [ "$code" -eq 0 ] || return 1
  id="$(json_field "$parsed" evidence.collectionId)"
  if [ -z "$id" ]; then
    args="$(json_obj orgId "$ORG" name twodev-proof)"
    prompt="Run exactly one sulla tool: files/create_org_collection with arguments ${args}. Do not run any other tool. Reply only JSON: {\"ok\":true or false,\"error\":null or reason,\"orgId\":\"id\",\"collectionId\":\"id\"}."
    parsed="$(agent_call a a5-setup create-org-collection files/create_org_collection "$prompt")" || code=$?
    [ "$code" -eq 0 ] || return 1
    id="$(json_field "$parsed" evidence.collectionId)"
  fi
  [ -n "$id" ] || die "a5-setup: create_org_collection returned no collectionId"
  printf '%s\n' "$id" >"$TWODEV_OUT/twodev-org-collection-id"
  echo "A5 setup: collectionId saved to $TWODEV_OUT/twodev-org-collection-id"
}

require_b2_session() {
  require_env B_USER
  [[ "$B_USER" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || die "B_USER must be a Cloud user UUID"
  if ! host_on b "grep -h 'SullaCloudAuth]' ~/Library/Logs/sulla-desktop/*.log 2>/dev/null | tail -2 | grep -F 'user=$B_USER' >/dev/null"; then
    die "B-imac Cloud user mismatch: sign the iMac into B2 (B_USER) before running B-side checks"
  fi
}

collection_id() {
  local value="${TWODEV_COLLECTION_ID:-}"
  if [ -z "$value" ] && [ -f "$TWODEV_OUT/twodev-org-collection-id" ]; then
    value="$(cat "$TWODEV_OUT/twodev-org-collection-id")"
  fi
  [[ "$value" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || die "set TWODEV_COLLECTION_ID or run a5-setup first"
  printf '%s' "$value"
}

cmd_a5() {
  local direction="${1:-both}" id nonce fname content prompt parsed code=0 side peer
  case "$direction" in a-to-b|b-to-a|both) ;; *) die "usage: $SCRIPT_NAME a5 [a-to-b|b-to-a|both]" ;; esac
  require_env ORG
  need_cmds python3 ssh
  id="$(collection_id)"
  for side in a b; do
    if [ "$direction" = "both" ] || { [ "$direction" = "a-to-b" ] && [ "$side" = a ]; } || { [ "$direction" = "b-to-a" ] && [ "$side" = b ]; }; then
      peer=b; [ "$side" = b ] && peer=a
      require_preflight "$side" "$peer"
      if [ "$peer" = b ]; then require_b2_session; fi
      nonce="$(new_nonce)"
      fname="twodev-a5-${side}-${nonce}.txt"
      content="twodev A5 ${side} ${nonce}"
      prompt="Two-device A5. Create source file ${fname} with exactly this content using write_file under /mnt/sulla-files/Projects/sulla-desktop/qa/two-device/: ${content}. Then run exactly one sulla tool: files/share_to_org with arguments $(json_obj source "/mnt/sulla-files/Projects/sulla-desktop/qa/two-device/${fname}" collectionId "$id" name "$fname"). Use read_file on the source to confirm the exact bytes, then exec `shasum -a 256` on that path for SHA-256. Reply only JSON {\"ok\":true or false,\"error\":null or reason,\"collectionId\":\"id\",\"sha256\":\"64 lowercase hex chars\"}; never include bytes."
      code=0
      parsed="$(agent_call "$side" a5-share-to-org files/share_to_org "$prompt" nonce="$nonce" file="$fname")" || code=$?
      if [ "$code" -ne 0 ]; then
        echo "A5 ${side}-to-${peer} FAIL: source creation/share failed (check the source path and explicit edit grant)" >&2
        return 1
      fi
      local expected_hash
      expected_hash="$(json_field "$parsed" evidence.sha256)"
      [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || die "A5 source agent did not report a valid SHA-256"
      prompt="Read-only A5 check. Run exactly one sulla tool: files/list_shared with arguments $(json_obj orgId "$ORG" collectionId "$id"). Find exact file ${fname} and its mounted path with files/list_shared, read it using read_file, then use exec `shasum -a 256` on that mounted path. Reply only JSON {\"ok\":true or false,\"error\":null or reason,\"found\":true or false,\"fileId\":\"id or null\",\"sha256\":\"64 lowercase hex chars\"}. Never include file contents. Expected SHA-256: ${expected_hash}."
      code=0
      parsed="$(agent_call "$peer" a5-read-shared files/list_shared "$prompt" nonce="$nonce" file="$fname")" || code=$?
      if [ "$code" -ne 0 ] || [ "$(json_field "$parsed" found)" != true ] || [ "$(json_field "$parsed" evidence.sha256)" != "$expected_hash" ]; then
        echo "A5 ${side}-to-${peer} FAIL: peer could not find/read $fname in org collection" >&2
        return 1
      fi
      echo "A5 ${side}-to-${peer}: PASS (peer found file; SHA-256 matches)"
    fi
  done
  echo "A5 RESULT: PASS (both directions; take File Manager evidence)"
}

cmd_a6() {
  local side="${1:-}" direction="${2:-both}" id path nonce fname content out rc peer start elapsed found attempt
  case "$side" in a|b) ;; *) die "usage: $SCRIPT_NAME a6 <a|b> [both]" ;; esac
  [ "$direction" = both ] || die "usage: $SCRIPT_NAME a6 <a|b> [both] (runs both directions)"
  require_env TWODEV_COLLECTION_PATH
  need_cmds python3 ssh
  id="$(collection_id)"
  require_preflight a b
  require_b2_session
  path="$TWODEV_COLLECTION_PATH"
  python3 -I -c 'import re,sys; sys.exit(0 if re.fullmatch(r"/mnt/sulla-files/Organizations/[^/]+/[^/]+", sys.argv[1]) else 1)' "$path" || die "TWODEV_COLLECTION_PATH must be the absolute mounted Organizations/<org>/<collection> path"
  for side in "$side" "$([ "$side" = a ] && echo b || echo a)"; do
    peer="$([ "$side" = a ] && echo b || echo a)"
    nonce="$(new_nonce)"
    fname="twodev-a6-${side}-${nonce}.txt"
    content="twodev A6 human ${side} ${nonce}"
    # Human path: a shell in that Mac's Sulla VM writes into the mounted Files folder, as the
    # Desktop terminal does. No AI, chat API or Files tool is involved in the write.
    out="/tmp/twodev-a6-${nonce}-write.out"
    guest_start "$side" "$out" "mkdir -p $(printf '%q' "$path") && printf '%s' $(printf '%q' "$content") > $(printf '%q' "$path/$fname")"
    rc="$(guest_wait "$side" "$out" 60 || true)"
    guest_cleanup "$side" "$out"
    if [ "$rc" != 0 ]; then echo "A6 FAIL: $(machine_label "$side") could not write $fname into the Files mount (exit ${rc:-timeout})" >&2; return 1; fi

    # Peer check: poll the same mount on the other Mac for up to 60s, 5s apart.
    start="$(date +%s)"
    found=0
    attempt=0
    while [ $(( $(date +%s) - start )) -lt "$A6_WAIT" ]; do
      attempt=$((attempt + 1))
      out="/tmp/twodev-a6-${nonce}-peer${attempt}.out"
      guest_start "$peer" "$out" "test -f $(printf '%q' "$path/$fname")"
      rc="$(guest_wait "$peer" "$out" 20 || true)"
      guest_cleanup "$peer" "$out"
      if [ "$rc" = 0 ]; then found=1; break; fi
      sleep 5
    done
    elapsed=$(( $(date +%s) - start ))
    log_evidence a6 "$(machine_label "$side")" "human-file-visible-on-peer" "$([ "$found" = 1 ] && echo 0 || echo 1)" "$(json_obj collectionId "$id" nonce "$nonce" file "$fname" found "$([ "$found" = 1 ] && echo true || echo false)")"
    if [ "$found" -ne 1 ]; then echo "A6 FAIL: $fname did not appear on peer within ${A6_WAIT}s; verify B2 sign-in, org enrollment, and edit grant" >&2; return 1; fi
    echo "A6 $(machine_label "$side") -> peer: PASS after ${elapsed}s ($fname)"
  done
  echo "A6 RESULT: PASS (both directions; confirm File Manager listing screenshots)"
}


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
  preflight          PONG round trip to each Mac's agent; PASS or FAIL with a reason (run this first)
  inventory          app version, codesign team id, uptime and directory call on both Macs
  a1                 each side's org/directory lists the other user (needs A_USER, B_USER)
  a2-send            A sends a nonce message to B's agent (needs A_USER, B_USER, B_AGENT_ID)
  a2-reply           B's agent replies with the nonce in the same conversation (after a2-send)
  a2-check           B's agent looks for the nonce in its org inbox (MANUAL if no tool can read it)
  a4 <a|b>           write an AI-created file on one side and confirm File Manager search
  a5-setup           create/reuse the twodev-proof org collection (needs ORG)
  a5 [direction]     AI share + receiver read/hash (a-to-b|b-to-a|both)
  a6 <a|b>           human Files mount write and peer check (TWODEV_A6_WAIT s (default 180), both directions; starts on given side)

Evidence is appended to \$TWODEV_OUT/evidence-<date>.jsonl.
USAGE
}

main() {
  need_cmds bash
  local step="${1:-}"
  case "$step" in
    preflight) cmd_preflight ;;
    inventory) cmd_inventory ;;
    a1) cmd_a1 ;;
    a2-send) cmd_a2_send ;;
    a2-reply) cmd_a2_reply ;;
    a2-check) cmd_a2_check ;;
    a4) shift; cmd_a4 "${1:-}" ;;
    a5-setup) cmd_a5_setup ;;
    a5) shift; cmd_a5 "${1:-both}" ;;
    a6) shift; cmd_a6 "${1:-}" "${2:-both}" ;;
    -h | --help | help | "") usage ;;
    *) usage >&2; die "unknown step: $step" ;;
  esac
}

main "$@"
