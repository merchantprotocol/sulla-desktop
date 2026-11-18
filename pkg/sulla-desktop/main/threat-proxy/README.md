# Threat Proxy Desktop backend

The Desktop owns egress enforcement and settings delivery. `enforced` redirects public TCP 80/443 to the proxy and rejects escaped 80/443; `direct` removes that redirect and accepts public 80/443 while preserving private/DNS handling and IPv6/UDP restrictions; `off` removes the egress chains and jumps. Health failures fail open to `direct`; enforcement resumes only after stable health and a published CA.

Traffic log contract for the proxy implementation: append JSON Lines to `<state>/log/traffic.jsonl`; rotate to `traffic.jsonl.1` at 2 MiB and retain at most two files. Each record is `{ts, client_ip, method, host, path, status, bytes, verdict, reason?}` with verdict `allowed|blocked|warned|injection|failed_open`; query parameter values in `path` must be replaced by `…`. Desktop mounts `log/` read-write and reads at most 4 MiB across both files.
