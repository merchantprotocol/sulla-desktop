# Threat-proxy OOM load harness

Disposable, isolated Docker test harness for `services/sulla-threat-proxy`. Never point it at live user traffic or `sulla_threat_proxy`. Requires Docker only on the host; helper image uses `python:3.13-slim`, pins `websockets==15.0.1` and `cryptography==46.0.3`, and runs Python syntax/summary work inside containers. The proxy is capped at 512 MiB with production hardening. `--state-root DIR` (default `${TMPDIR:-/tmp}`) controls temporary proxy state; `--results DIR` selects retained CSV/JSON/Markdown outputs. Every run samples every 2 seconds during load and for 30 seconds afterward (`SETTLE=30` overrides it), then prints one `SUMMARY ...` line including peak, steady and settled MiB, OOM/alive, client errors and security status. Each run removes only its own named containers/network/helper image and temporary state. `--keep` retains resources for debugging.

The origin offers HTTP on 8080, WebSocket on 8081, and HTTPS on 8443. HTTPS uses a fresh self-signed `*.test` certificate; only the disposable proxy entrypoint copy gets `--set ssl_insecure=true`, so production files are untouched. `--https` on client scenarios sends requests through CONNECT and trusts the proxy's generated CA. The proxy receives `/etc/hosts` entries for `host-N.test` names; `many_hosts` is capped at 2000 (default) to keep Docker argument size bounded and exercises SNI certificate generation/cache churn.

`conn_churn` models proxy memory growth from TLS connection turnover: each request uses an HTTPS CONNECT tunnel to the local HTTPS origin and requests `--size` bytes (default 200000). `--minutes` is the load window, `--concurrency` sets worker threads, and `--rate` caps aggregate request starts per second (default 20). The default `--sni-mode same` keeps the origin hostname; `--sni-mode unique` rotates requests over `--hosts` mapped `host-N.test` names. `--keepalive` reuses one CONNECT/TLS connection per worker as the control. The client JSON records `requests_completed`, `errors`, and duration.

Set `MEMDIAG=1` for this harness only to load `memdiag.py` into mitmdump. It emits JSON `MEMDIAG` lines every 60 seconds and on shutdown, including tracemalloc top lines, selected live-object counts, GC counts, fd count and RSS; the final line records RSS around `gc.collect()` + `malloc_trim(0)`. `summary.md` includes first/last diagnostic records and the three largest-growing tracemalloc source lines. This addon is not part of `services/sulla-threat-proxy` or the shipped image.

WebSockets use `websockets==15.0.1` client HTTP-proxy support (`proxy=http://proxy:8890`) and the standard ws:// handshake through the proxy, no CONNECT. Each socket receives `--msg-kb` (default 64) payloads at `--rate` messages/second for `--minutes`; summary records received messages and connection errors.

## Commands

Set `IMAGE` to the disposable proxy image under test, then run any scenario:

```sh
IMAGE='ghcr.io/merchantprotocol/sulla-threat-proxy:TAG'
scripts/qa/threat-proxy/run.sh "$IMAGE" concurrent --size 15000000 --concurrency 12
scripts/qa/threat-proxy/run.sh "$IMAGE" concurrent --size 5000000 --ctype text/markdown --concurrency 20
scripts/qa/threat-proxy/run.sh "$IMAGE" gzip_bomb --decoded 1000000000 --concurrency 1
scripts/qa/threat-proxy/run.sh "$IMAGE" llm_prompts --mb 10 --concurrency 50
scripts/qa/threat-proxy/run.sh "$IMAGE" big_download --sizes 2000000000
scripts/qa/threat-proxy/run.sh "$IMAGE" big_upload --size 1000000000
scripts/qa/threat-proxy/run.sh "$IMAGE" sse_long --minutes 10 --concurrency 50
scripts/qa/threat-proxy/run.sh "$IMAGE" websockets --minutes 10 --concurrency 100
scripts/qa/threat-proxy/run.sh "$IMAGE" many_hosts --https --hosts 2000
scripts/qa/threat-proxy/run.sh "$IMAGE" blocked_url_check
scripts/qa/threat-proxy/run.sh "$IMAGE" injection_check
scripts/qa/threat-proxy/run.sh "$IMAGE" soak --duration 7200
```

`--https` is available for `concurrent`, `big_download`, `big_upload`, `gzip_bomb`, `llm_prompts`, `many_hosts`, `sse_long`, and `injection_check`. `concurrent` accepts `--ctype` (default `text/html`), `--chunked 0|1|mixed` (default mixed), `--size`, `--concurrency` and `--rounds` (default 1). Use reduced sizes/counts for a smoke run. Large baselines intentionally consume substantial network and host resources.

Results include per-sample `samples.csv`, `proxy-inspect.json`, `client-<scenario>.json`, `results.json` and `summary.md`. Peak is cgroup `memory.peak`; steady is median of the final quarter of load samples; settled is median post-load idle samples. Security is `pass` only when checks ran and all passed; otherwise `fail` or `n/a`.

### Connection churn runs

```sh
MEMDIAG=1 scripts/qa/threat-proxy/run.sh "$IMAGE" conn_churn --minutes 20 --concurrency 24 --rate 20 --size 200000 --sni-mode same
MEMDIAG=1 scripts/qa/threat-proxy/run.sh "$IMAGE" conn_churn --minutes 20 --concurrency 24 --rate 20 --size 200000 --sni-mode unique --hosts 2000
MEMDIAG=1 scripts/qa/threat-proxy/run.sh "$IMAGE" conn_churn --minutes 20 --concurrency 24 --rate 20 --size 200000 --sni-mode same --keepalive
```
