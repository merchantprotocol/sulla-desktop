#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
#
# Create-latency trace for the Files FUSE mount. Run INSIDE the Desktop VM as root (docker available).
# Writes only under one per-run QA folder on the mount. Procedure and how to read the numbers: create-trace.md.
#
#   create-trace.sh run <label> <count> [parallel=1]   N creates through the mount (serial, or P-way)
#   create-trace.sh pg-count <label>                   one create with log_min_duration_statement=0; counts statements and commits
#   create-trace.sh summary <label>                    print the computed split for a finished run
#
# Output: $TRACE_OUT/<label>/ (default /mnt/worktrees/_scratch/create-trace/<label>/). Delete it once the numbers are recorded.
# The only setting this script changes is log_min_duration_statement, and pg-count always reverts it.
#
# Environment (optional):
#   TRACE_MOUNT         Files mount seen by the VM (default /mnt/sulla/files if mounted, else /mnt/sulla-files)
#   TRACE_OUT           output root
#   SOAK_FILES_CONTAINER / SOAK_FUSE_CONTAINER / SOAK_PG_CONTAINER / SOAK_PG_USER / SOAK_PG_DB
#                       defaults sulla_files / sulla_files_fuse / sulla_postgres / sulla / sulla

set -euo pipefail

CMD="${1:-}"; LABEL="${2:-}"
if [[ -z "$CMD" || -z "$LABEL" ]]; then
  echo "usage: create-trace.sh run <label> <count> [parallel] | pg-count <label> | summary <label>" >&2
  exit 2
fi
if [[ ! "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then echo "label must match [A-Za-z0-9._-]+" >&2; exit 2; fi

CONTAINER_FILES="${SOAK_FILES_CONTAINER:-sulla_files}"
CONTAINER_FUSE="${SOAK_FUSE_CONTAINER:-sulla_files_fuse}"
CONTAINER_PG="${SOAK_PG_CONTAINER:-sulla_postgres}"
PG_USER="${SOAK_PG_USER:-sulla}"
PG_DB="${SOAK_PG_DB:-sulla}"
if [[ -n "${TRACE_MOUNT:-}" ]]; then
  MOUNT="$TRACE_MOUNT"
elif mountpoint -q /mnt/sulla/files 2>/dev/null; then
  MOUNT=/mnt/sulla/files
else
  MOUNT=/mnt/sulla-files
fi
OUT_ROOT="${TRACE_OUT:-/mnt/worktrees/_scratch/create-trace}"
OUT="$OUT_ROOT/$LABEL"
QA_DIR="$MOUNT/QA/create-trace-$LABEL"

# Runs inside sulla_files. The local token never leaves that container; only the HTTP status and the
# metrics JSON (numbers only) are printed.
METRICS_PROBE='
const http = require("http");
const token = process.env.SULLA_FILES_LOCAL_TOKEN || "";
const port = process.env.SULLA_FILES_PORT || "8792";
if (!token) { console.log(JSON.stringify({ error: "no_local_token" })); process.exit(0); }
const req = http.request({ host: "127.0.0.1", port, path: "/v1/local/files-metrics", method: "GET", headers: { "x-sulla-files-token": token } }, res => {
  let body = ""; res.on("data", c => body += c); res.on("end", () => console.log(JSON.stringify({ status: res.statusCode, body })));
});
req.on("error", e => console.log(JSON.stringify({ error: e.code || e.name })));
req.setTimeout(10000, () => { req.destroy(); console.log(JSON.stringify({ error: "timeout" })); });
req.end();
'

now_ms() { python3 -I -c 'import time; print(int(time.time() * 1000))'; }

# $1 = output file. Writes the numeric snapshot only; fails loudly if the endpoint is unavailable.
snapshot_metrics() {
  local wrapper_file="$1.wrapper"
  docker exec "$CONTAINER_FILES" node -e "$METRICS_PROBE" 2>/dev/null | grep '^{' | tail -n 1 > "$wrapper_file" || true
  python3 -I - "$wrapper_file" "$1" <<'PYSNAP'
import json, sys
raw = open(sys.argv[1]).read().strip()
wrapper = json.loads(raw) if raw else {}
if wrapper.get("error") or wrapper.get("status") != 200:
    raise SystemExit("metrics unavailable: %s" % (wrapper.get("error") or wrapper.get("status")))
open(sys.argv[2], "w").write(json.dumps(json.loads(wrapper["body"]), sort_keys=True))
PYSNAP
  rm -f "$wrapper_file"
}

cmd_run() {
  local count="$1" parallel="${2:-1}"
  [[ "$count" =~ ^[0-9]+$ && "$parallel" =~ ^[0-9]+$ ]] || { echo "count and parallel must be integers" >&2; exit 2; }
  mkdir -p "$OUT" "$QA_DIR"
  snapshot_metrics "$OUT/metrics-before.json"
  local started t1 since
  started="$(now_ms)"; since="$(( started / 1000 - 2 ))"
  if (( parallel <= 1 )); then
    for i in $(seq 1 "$count"); do printf x > "$QA_DIR/serial-$i.txt"; done
  else
    seq 1 "$count" | xargs -P "$parallel" -I{} sh -c 'printf x > "$1/par-$2.txt"' create-trace "$QA_DIR" {}
  fi
  t1="$(now_ms)"
  snapshot_metrics "$OUT/metrics-after.json"
  # Adapter op lines since the run started. Keep only the write-path ops; the raw log is discarded.
  docker logs --since "$since" "$CONTAINER_FUSE" 2>&1 | grep '"event":"fuse-op"' > "$OUT/adapter-ops.raw.jsonl" || true
  python3 -I - "$OUT/adapter-ops.raw.jsonl" "$OUT/adapter-ops.jsonl" <<'PYOPS'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as handle, open(dst, "w") as out:
    for line in handle:
        try: entry = json.loads(line)
        except ValueError: continue
        if entry.get("op") in ("create", "release", "rename", "mkdir"): out.write(json.dumps(entry, sort_keys=True) + "\n")
PYOPS
  rm -f "$OUT/adapter-ops.raw.jsonl"
  printf '{"label":"%s","count":%s,"parallel":%s,"wallMs":%s,"startedMs":%s}\n' "$LABEL" "$count" "$parallel" "$(( t1 - started ))" "$started" > "$OUT/run.json"
  cmd_summary
}

cmd_pg_count() {
  mkdir -p "$OUT" "$QA_DIR"
  pg_sql() { docker exec "$CONTAINER_PG" psql -U "$PG_USER" -d "$PG_DB" -At -c "$1" > /dev/null; }
  # The revert runs on exit even if the create fails, so statement logging never stays on.
  trap 'pg_sql "ALTER SYSTEM RESET log_min_duration_statement" 2>/dev/null || true; pg_sql "SELECT pg_reload_conf()" 2>/dev/null || true' EXIT
  pg_sql "ALTER SYSTEM SET log_min_duration_statement = 0"
  pg_sql "SELECT pg_reload_conf()"
  # Unique marker statements bracket each window in the Postgres log, so no clock or timezone is needed.
  pg_sql "SELECT 'ct-base-start-$LABEL'"; sleep 10; pg_sql "SELECT 'ct-base-end-$LABEL'"
  pg_sql "SELECT 'ct-create-start-$LABEL'"
  printf x > "$QA_DIR/pg-count-$LABEL.txt"
  pg_sql "SELECT 'ct-create-end-$LABEL'"
  pg_sql "ALTER SYSTEM RESET log_min_duration_statement"
  pg_sql "SELECT pg_reload_conf()"
  trap - EXIT
  docker logs "$CONTAINER_PG" > "$OUT/pg-log.raw" 2>&1 || true
  python3 -I - "$OUT/pg-log.raw" "$OUT/pg-count.json" "$LABEL" <<'PYPG'
import json, sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
def window(start_tag, end_tag):
    """Log lines strictly between two marker statements. Each completed statement logs one 'duration:' line."""
    inside, lines = False, []
    for raw in open(src, errors="replace"):
        if f"ct-{start_tag}-{label}" in raw and "statement:" in raw: inside, lines = True, []; continue
        if f"ct-{end_tag}-{label}" in raw and "statement:" in raw: break
        if inside: lines.append(raw)
    statements = [line for line in lines if "duration:" in line and ("statement:" in line or "execute " in line)]
    return {"statements": len(statements),
            "commits": sum(1 for line in statements if "statement: COMMIT" in line),
            "rollbacks": sum(1 for line in statements if "statement: ROLLBACK" in line),
            "begins": sum(1 for line in statements if "statement: BEGIN" in line)}
result = {"label": label, "baselineIdle10s": window("base-start", "base-end"), "oneCreate": window("create-start", "create-end")}
open(dst, "w").write(json.dumps(result, indent=2, sort_keys=True))
print(json.dumps(result, sort_keys=True))
PYPG
  rm -f "$OUT/pg-log.raw"
  echo "pg-count written to $OUT/pg-count.json; log_min_duration_statement reverted"
}

cmd_summary() {
  python3 -I - "$OUT" <<'PYSUM'
import json, os, sys
out = sys.argv[1]
def pct(values, q):
    if not values: return None
    ordered = sorted(values)
    return round(ordered[max(0, -(-q * len(ordered) // 100) - 1)], 1)
def delta(name, before, after):
    b, a = before.get(name, {}), after.get(name, {})
    dc = a.get("count", 0) - b.get("count", 0); dt = a.get("totalMs", 0) - b.get("totalMs", 0)
    return {"count": dc, "meanMs": round(dt / dc, 1) if dc else None, "maxLifetimeMs": a.get("maxMs")}
before = json.load(open(os.path.join(out, "metrics-before.json")))
after = json.load(open(os.path.join(out, "metrics-after.json")))
ops = [json.loads(line) for line in open(os.path.join(out, "adapter-ops.jsonl")) if line.strip()]
by_op = {}
for entry in ops: by_op.setdefault(entry["op"], []).append(entry)
per_op = {}
for name, rows in sorted(by_op.items()):
    ms = [row["ms"] for row in rows if row.get("ms") is not None]
    files = [row.get("files_ms") or 0 for row in rows]
    adapter = [row["ms"] - (row.get("files_ms") or 0) for row in rows if row.get("ms") is not None]
    per_op[name] = {"n": len(rows), "errors": sum(1 for row in rows if row.get("ok") is False),
                    "opMsP50": pct(ms, 50), "opMsP95": pct(ms, 95), "filesMsP50": pct(files, 50),
                    "adapterMsP50": pct(adapter, 50), "adapterMsP95": pct(adapter, 95)}
summary = {"ops": per_op, "files": {name: delta(name, before, after) for name in ("txn", "audit", "fuseRoute", "stage", "chunkWrite", "poolWait")}}
if "release" not in by_op:
    summary["note"] = "no release op lines: the adapter logs release only at DEBUG, so the PUT split is missing from this run"
open(os.path.join(out, "summary.json"), "w").write(json.dumps(summary, indent=2, sort_keys=True))
print(json.dumps(summary, indent=2, sort_keys=True))
PYSUM
}

case "$CMD" in
  run)
    [[ -n "${3:-}" ]] || { echo "usage: create-trace.sh run <label> <count> [parallel]" >&2; exit 2; }
    cmd_run "$3" "${4:-1}" ;;
  pg-count) cmd_pg_count ;;
  summary) cmd_summary ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac
