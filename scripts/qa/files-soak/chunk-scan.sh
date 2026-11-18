#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
#
# Read-only chunk integrity scan. Run INSIDE the Desktop VM as root (docker available).
# Lists chunk ids that the collection's current key cannot decrypt, and chunk ids with no blob. Ids and counts only.
# It never writes to the database or the blob store, and it never prints plaintext or keys.
#
#   chunk-scan.sh [--diagnose] [collectionId] [limit]
#
#   --diagnose    optional; for each AEAD failure, report which other collection's data key opens it (ids and key fingerprints only, at most 50 chunks per page)
#   collectionId  optional UUID; scan only that collection
#   limit         optional positive integer; chunks per page per collection (default 2000, server clamps to 10000)
#
# The endpoint is paged. This script loops pages (cursor = last chunk id) until every collection reports no nextCursor,
# then prints ONE merged report with the same shape as GET /v1/local/chunk-integrity/scan, plus `pages`.
#
# Environment (optional):
#   SOAK_FILES_CONTAINER   Files container (default sulla_files)

set -euo pipefail

CONTAINER_FILES="${SOAK_FILES_CONTAINER:-sulla_files}"
DIAGNOSE=""
POSITIONAL=()
for arg in "$@"; do
  if [[ "$arg" == "--diagnose" ]]; then DIAGNOSE=1; else POSITIONAL+=("$arg"); fi
done
COLLECTION_ID="${POSITIONAL[0]:-}"
LIMIT="${POSITIONAL[1]:-}"

if [[ -n "$COLLECTION_ID" && ! "$COLLECTION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "collectionId must be a UUID" >&2
  exit 2
fi
if [[ -n "$LIMIT" && ! "$LIMIT" =~ ^[1-9][0-9]*$ ]]; then
  echo "limit must be a positive integer" >&2
  exit 2
fi
if [[ -z "$LIMIT" ]]; then LIMIT=2000; fi

# Runs inside sulla_files. The local token never leaves that container; only the HTTP status and the report are printed.
SCAN_PROBE='
const https = require("https");
const fs = require("fs");
const token = process.env.SULLA_FILES_LOCAL_TOKEN || "";
const port = process.env.SULLA_FILES_PORT || "8792";
if (!token) { console.log(JSON.stringify({ error: "no_local_token" })); process.exit(0); }
// sulla_files serves HTTPS only. Pin its own certificate when it covers 127.0.0.1 (IP SAN);
// otherwise skip verification, which is safe only because the host is hardcoded to loopback.
let tls = { rejectUnauthorized: false };
try {
  const pem = fs.readFileSync(process.env.SULLA_FILES_TLS_CERTIFICATE_PATH || process.env.SULLA_FILES_TLS_CA_FILE);
  if (new (require("crypto").X509Certificate)(pem).checkIP("127.0.0.1")) tls = { ca: pem };
} catch (e) { /* no readable cert: keep the loopback-only fallback */ }
const query = process.env.SCAN_QUERY || "";
const req = https.request({ host: "127.0.0.1", port, path: "/v1/local/chunk-integrity/scan" + query, method: "GET", headers: { "x-sulla-files-token": token }, ...tls }, res => {
  let body = ""; res.on("data", c => body += c); res.on("end", () => console.log(JSON.stringify({ status: res.statusCode, body })));
});
req.on("error", e => console.log(JSON.stringify({ error: e.code || e.name })));
req.setTimeout(600000, () => { req.destroy(); console.log(JSON.stringify({ error: "timeout" })); });
req.end();
'

# Page loop runs in python: one `docker exec` per page, each page is the same node probe as before. Ids and counts only.
python3 -I -c '
import json, subprocess, sys
container, probe, collection_id, limit, diagnose = sys.argv[1:6]
TIMEOUT = 700
MAX_PAGES = 100000

def fetch(query):
    try:
        out = subprocess.run(["docker", "exec", "-e", "SCAN_QUERY=" + query, container, "node", "-e", probe],
                             capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        sys.stderr.write("chunk scan unavailable: page timed out\n"); sys.exit(1)
    line = next((ln for ln in out.stdout.splitlines() if ln.startswith("{")), "")
    if not line:
        sys.stderr.write("chunk scan unavailable: no response from %s\n" % container); sys.exit(1)
    wrapper = json.loads(line)
    if wrapper.get("error") or wrapper.get("status") != 200:
        sys.stderr.write("chunk scan failed: %s\n" % (wrapper.get("error") or wrapper.get("status"))); sys.exit(1)
    return json.loads(wrapper["body"])

def base_query(extra):
    params = []
    if collection_id: params.append("collectionId=" + collection_id)
    params.append("limit=" + limit)
    if diagnose: params.append("diagnose=1")
    params.extend(extra)
    return "?" + "&".join(params)

merged = {}   # collectionId -> merged collection entry (ids and counts only)
pages = 0
first = fetch(base_query([]))
pages += 1
for entry in first["collections"]:
    merged[entry["collectionId"]] = entry
pending = [c["collectionId"] for c in first["collections"] if c.get("nextCursor")]
for cid in pending:
    entry = merged[cid]
    while entry.get("nextCursor"):
        cursor = entry["nextCursor"]
        if pages >= MAX_PAGES:
            sys.stderr.write("chunk scan stopped: page limit reached\n"); sys.exit(1)
        page = fetch("?" + "&".join(["collectionId=" + cid, "cursor=" + cursor, "limit=" + limit] + (["diagnose=1"] if diagnose else [])))
        pages += 1
        got = next((c for c in page["collections"] if c["collectionId"] == cid), None)
        if got is None:
            sys.stderr.write("chunk scan failed: collection missing from a later page\n"); sys.exit(1)
        if got["chunksScanned"] == 0 and got.get("nextCursor") == cursor:
            sys.stderr.write("chunk scan failed: cursor did not advance\n"); sys.exit(1)
        entry["chunksScanned"] += got["chunksScanned"]
        for key in ("undecryptable", "failures", "missingBlob"):
            entry[key].extend(got[key])
        entry["errors"] += got["errors"]
        entry["nextCursor"] = got.get("nextCursor")

collections = [merged[c["collectionId"]] for c in first["collections"]]
for entry in collections:
    entry["undecryptable"].sort()
    entry["failures"].sort(key=lambda f: f["chunkId"])
    entry["missingBlob"].sort()
report = {
    "scannedAt": first["scannedAt"],
    "limit": first.get("limit"),
    "pages": pages,
    "collections": collections,
    "totals": {
        "collections": len(collections),
        "chunksScanned": sum(c["chunksScanned"] for c in collections),
        "undecryptable": sum(len(c["undecryptable"]) for c in collections),
        "missingBlob": sum(len(c["missingBlob"]) for c in collections),
        "errors": sum(c["errors"] for c in collections),
    },
}
print(json.dumps(report, indent=2, sort_keys=True))
' "$CONTAINER_FILES" "$SCAN_PROBE" "$COLLECTION_ID" "$LIMIT" "${DIAGNOSE:-}"
