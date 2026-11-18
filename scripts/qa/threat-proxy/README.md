# Threat-proxy load and soak harness

This harness measures a disposable Sulla threat-proxy container under bounded
and sustained HTTP load. It never looks up, stops, or modifies containers named
`sulla_*`. **Never aim it at the live `sulla_threat_proxy` or any live user
traffic.** Use an isolated QA machine and a disposable proxy image.

## Requirements and outputs

Requires Docker Engine/CLI and the proxy image under test. The helper image is
built from the included Python 3.13 slim Dockerfile (multi-architecture base).
The script creates an isolated `tproxy-oom-<runid>` network, a private state
directory, one proxy (512 MiB cap and production hardening), an origin and a
client. It removes those exact containers, the network, helper image and state
directory at exit. `--keep` retains those resources for debugging; clean them
up manually by their printed run ID. Results are retained in
`./tproxy-oom-results-<runid>/` (CSV samples every 2 seconds, inspect JSON,
client JSON and summary JSON/Markdown).

The origin and client are standard-library Python. Both stream response bodies
in 64 KiB chunks and discard them. Client request concurrency and body sizes
are configurable; use small values for smoke checks. `--keep` is optional and
precedes the image argument.

## Scenarios

All commands accept `IMAGE` followed by scenario and options. Defaults are
deliberately moderate except `soak` (2 hours).

| Scenario | Default / controls | Typical runtime |
|---|---|---|
| `big_download` | 100 MB; `--sizes 10000000,100000000,1000000000,2000000000`; HTML and octet-stream, both length modes | data-size dependent |
| `big_upload` | 100 MB; `--size N --concurrency N` | data-size dependent |
| `concurrent` | 20 simultaneous 100 MB HTML streams; `--size N --concurrency N` | data-size dependent |
| `llm_prompts` | 20 JSON POSTs of 10 MiB; `--mb N --concurrency N` | typically minutes |
| `sse_long` | 20 streams for 1 minute; `--minutes N --concurrency N` | requested duration |
| `websockets` | currently reports unsupported scenario errors; stdlib origin does not implement WebSocket | immediate |
| `gzip_bomb` | 20 compressed responses, each decompressing to 100 MB; `--decoded N --concurrency N` | data-size dependent |
| `many_hosts` | 20 distinct HTTP Host values; `--concurrency N` | seconds to minutes |
| `blocked_url_check` | asserts blocked host returns HTTP 451 | seconds |
| `injection_check` | asserts prompt-injection response header | seconds |
| `soak` | weighted repeating mix for 7200 seconds; `--duration SECONDS` | requested duration |

Example baseline runs against an image ref (replace the placeholder with the
tag or registry digest being measured):

```sh
IMAGE='ghcr.io/merchantprotocol/sulla-threat-proxy:TAG'
scripts/qa/threat-proxy/run.sh "$IMAGE" big_download --sizes 10000000
scripts/qa/threat-proxy/run.sh "$IMAGE" blocked_url_check
scripts/qa/threat-proxy/run.sh "$IMAGE" concurrent --size 12000000 --concurrency 200
scripts/qa/threat-proxy/run.sh "$IMAGE" llm_prompts --mb 10 --concurrency 50
scripts/qa/threat-proxy/run.sh "$IMAGE" soak --duration 7200
```

Run each invocation independently to get a CSV and summary per scenario. Check
the summary's cgroup peak and steady-state MiB, OOMKilled/restart state, client
errors and security results. Keep local machine and Docker memory headroom in
mind: intentionally high connection counts can affect the machine running the
harness too.

## Known limits

The checked-in proxy entrypoint has no extra-args hook, and this harness does
not alter production code to add one. Consequently current scenarios exercise
the proxy's regular HTTP mode; the HTTPS origin/certificate-verification-bypass
path, WebSocket protocol workload, truly streaming large JSON POST bodies, and
TLS SNI/certificate-cache stress are not implemented yet. `many_hosts` exercises
distinct HTTP host values, not SNI. `gzip_bomb` emits concatenated gzip members
to bound origin memory; not every client/proxy version handles concatenated
members identically. Validate that aspect before interpreting those readings.
