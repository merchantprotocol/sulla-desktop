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
#   --diagnose    optional; for each AEAD failure, report which other collection's data key opens it (ids and key fingerprints only, at most 50 chunks)
#   collectionId  optional UUID; scan only that collection
#   limit         optional 1..100000; chunks scanned per collection (default 10000)
#
# Output: the JSON report from GET /v1/local/chunk-integrity/scan, printed as-is.
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

QUERY=""
if [[ -n "$COLLECTION_ID" ]]; then QUERY="collectionId=$COLLECTION_ID"; fi
if [[ -n "$LIMIT" ]]; then QUERY="${QUERY:+$QUERY&}limit=$LIMIT"; fi
if [[ -n "$DIAGNOSE" ]]; then QUERY="${QUERY:+$QUERY&}diagnose=1"; fi
[[ -n "$QUERY" ]] && QUERY="?$QUERY"

WRAPPER="$(docker exec -e SCAN_QUERY="$QUERY" "$CONTAINER_FILES" node -e "$SCAN_PROBE" 2>/dev/null | grep '^{' | tail -n 1 || true)"
if [[ -z "$WRAPPER" ]]; then
  echo "chunk scan unavailable: no response from $CONTAINER_FILES" >&2
  exit 1
fi

python3 -I -c '
import json, sys
wrapper = json.loads(sys.argv[1])
if wrapper.get("error") or wrapper.get("status") != 200:
    sys.stderr.write("chunk scan failed: %s\n" % (wrapper.get("error") or wrapper.get("status")))
    sys.exit(1)
print(json.dumps(json.loads(wrapper["body"]), indent=2, sort_keys=True))
' "$WRAPPER"
