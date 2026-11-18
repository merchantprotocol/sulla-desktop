#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
set -eu
usage() { echo "Usage: $0 [--keep] [--state-root DIR] [--results DIR] IMAGE SCENARIO [client options]" >&2; exit 2; }
keep=0; state_root=${TMPDIR:-/tmp}; results_arg=
while [ "$#" -gt 0 ]; do case "$1" in --keep) keep=1; shift;; --state-root) [ "$#" -ge 2 ] || usage; state_root=$2; shift 2;; --results) [ "$#" -ge 2 ] || usage; results_arg=$2; shift 2;; *) break;; esac; done
[ "$#" -ge 2 ] || usage
image=$1; scenario=$2; shift 2
case "$scenario" in big_download|big_upload|concurrent|llm_prompts|sse_long|websockets|gzip_bomb|many_hosts|blocked_url_check|injection_check|soak) ;; *) usage ;; esac
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 127; }
runid="$(date +%s)-$$"; network="tproxy-oom-$runid"; proxy="tproxy-oom-$runid-proxy"; origin="tproxy-oom-$runid-origin"; client="tproxy-oom-$runid-client"
mkdir -p "$state_root"; state=$(mktemp -d "$state_root/tproxy-oom-$runid.XXXXXX"); results=${results_arg:-"$(pwd)/tproxy-oom-results-$runid"}; mkdir -p "$state/mitm" "$state/cache" "$state/public" "$state/config" "$state/blocklist" "$results"; chmod 0777 "$state" "$state/mitm" "$state/cache" "$state/public" "$state/config" "$state/blocklist" "$results"
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd); cp "$repo_root/services/sulla-threat-proxy/blocklist/urlhaus-default.txt" "$state/blocklist/urlhaus.txt"
cleanup() { if [ "$keep" -eq 1 ]; then echo "Kept resources: network=$network state=$state"; return; fi; docker rm -f "$client" "$origin" "$proxy" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; docker rmi "tproxy-oom-harness:$runid" >/dev/null 2>&1 || true; rm -rf -- "$state"; }
trap cleanup EXIT HUP INT TERM
docker build -t "tproxy-oom-harness:$runid" "$(dirname "$0")"; helper="tproxy-oom-harness:$runid"; docker network create "$network" >/dev/null
docker run -d --name "$origin" --network "$network" --network-alias origin --network-alias 02teste.cc "$helper" origin.py >/dev/null
hosts=2000; [ "$scenario" = many_hosts ] || [ "$scenario" = soak ] || hosts=0; prev=; for arg in "$@"; do if [ "$prev" = --hosts ]; then hosts=$arg; prev=; continue; fi; [ "$arg" = --hosts ] && prev=--hosts; done
case "$hosts" in *[!0-9]*|"") echo "--hosts must be numeric" >&2; exit 2;; esac
[ "$hosts" -le 2000 ] || { echo "--hosts cap is 2000" >&2; exit 2; }
origin_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$origin"); host_args="--add-host=02teste.cc:$origin_ip"; i=0
while [ "$i" -lt "$hosts" ]; do host_args="$host_args --add-host=host-$i.test:$origin_ip"; i=$((i+1)); done
# Run actual entrypoint logic copied from source, adding only the harness-only upstream verification override.
repo_entry="$repo_root/services/sulla-threat-proxy/entrypoint.sh"; sed '/^[[:space:]]*--set connection_strategy=lazy/a\  --set ssl_insecure=true \\' "$repo_entry" > "$state/entrypoint.sh"; chmod 0755 "$state/entrypoint.sh"
docker run -d --name "$proxy" --network "$network" --network-alias proxy --user 10010:10010 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --memory-swap 512m -e SULLA_PROXY_MODE=regular -e SULLA_PROXY_STATE_DIR=/var/lib/sulla-threat-proxy -v "$state/entrypoint.sh:/harness-entrypoint.sh:ro" -v "$state/mitm:/var/lib/sulla-threat-proxy/mitm" -v "$state/cache:/var/lib/sulla-threat-proxy/cache" -v "$state/public:/var/lib/sulla-threat-proxy/public" -v "$state/config:/var/lib/sulla-threat-proxy/config:ro" -v "$state/blocklist:/var/lib/sulla-threat-proxy/blocklist:ro" $host_args --entrypoint /bin/sh "$image" /harness-entrypoint.sh >/dev/null
# Fail early with the proxy startup diagnostics instead of running clients against a dead container.
startup=0
while [ "$startup" -lt 15 ]; do
  if docker inspect -f '{{.State.Running}}' "$proxy" 2>/dev/null | grep -q true; then break; fi
  exited=$(docker inspect -f '{{.State.Status}}' "$proxy" 2>/dev/null || echo missing)
  [ "$exited" = running ] || break
  sleep 1; startup=$((startup+1))
done
if ! docker inspect -f '{{.State.Running}}' "$proxy" 2>/dev/null | grep -q true; then
  echo "Threat proxy failed to start (status: $(docker inspect -f '{{.State.Status}}' "$proxy" 2>/dev/null || echo missing)); logs follow:" >&2
  docker logs "$proxy" >&2 2>&1 || true
  docker inspect "$proxy" >&2 2>/dev/null || true
  exit 1
fi
# Running is not ready: mitmproxy still has to load addons and bind the listener.
ready=0
while [ "$startup" -lt 45 ]; do
  if docker exec "$proxy" python3 -c 'import socket; socket.create_connection(("127.0.0.1", 8890), 1).close()' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1; startup=$((startup+1))
done
if [ "$ready" -ne 1 ]; then
  echo "Threat proxy did not become ready on port 8890; logs follow:" >&2
  docker logs "$proxy" >&2 2>&1 || true
  docker inspect "$proxy" >&2 2>/dev/null || true
  exit 1
fi
printf 'scenario,timestamp,stats_mem,stats_limit,memory_current,memory_peak,oom,oom_kill,vmrss,vmhwm,phase\n' > "$results/samples.csv"
docker run -d --name "$client" --network "$network" --user 0 -v "$state/public:/state/public:ro" -v "$results:/results" "$helper" client.py --scenario "$scenario" --proxy http://proxy:8890 --origin http://origin:8080 --ca /state/public/ca-bundle.pem --output "/results/client-$scenario.json" "$@" >/dev/null
sample() { phase=$1; stats=$(docker stats --no-stream --format '{{.MemUsage}}' "$proxy" 2>/dev/null || echo unavailable); current=$(docker exec "$proxy" cat /sys/fs/cgroup/memory.current 2>/dev/null || echo ''); peak=$(docker exec "$proxy" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo ''); events=$(docker exec "$proxy" cat /sys/fs/cgroup/memory.events 2>/dev/null || echo ''); oom=$(printf '%s\n' "$events" | awk '$1=="oom"{print $2}'); oomkill=$(printf '%s\n' "$events" | awk '$1=="oom_kill"{print $2}'); rss=$(docker exec "$proxy" awk '/VmRSS:/{print $2}' /proc/1/status 2>/dev/null || echo ''); hwm=$(docker exec "$proxy" awk '/VmHWM:/{print $2}' /proc/1/status 2>/dev/null || echo ''); printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$scenario" "$(date -u +%FT%TZ)" "$stats" '' "$current" "$peak" "$oom" "$oomkill" "$rss" "$hwm" "$phase" >> "$results/samples.csv"; }
while docker inspect -f '{{.State.Running}}' "$client" 2>/dev/null | grep -q true; do sample load; sleep 2; done
client_exit=$(docker wait "$client" 2>/dev/null || echo 1); docker logs "$client" > "$results/client.log" 2>&1 || true; i=0; while [ "$i" -lt "${SETTLE:-30}" ]; do sample settled; sleep 2; i=$((i+2)); done
docker inspect "$proxy" > "$results/proxy-inspect.json" 2>/dev/null || true
docker logs "$proxy" > "$results/proxy.log" 2>&1 || true
docker run --rm --user 0 -v "$results:/results" "$helper" summary.py --samples /results/samples.csv --inspect /results/proxy-inspect.json --client "/results/client-$scenario.json" --scenario "$scenario" --output /results/results.json >/dev/null
cat "$results/summary.md"
python_cmd='import json,sys; d=json.load(open(sys.argv[1])); print("SUMMARY %s peak_mib=%s steady_mib=%s settled_mib=%s oom=%s alive=%s client_errors=%s security=%s"%(d["scenario"],d["peak_mib"],d["steady_state_mib"],d.get("settled_state_mib"),d["oom_killed"],d["proxy_alive_after"],d["client_errors"],"pass" if d["security_checks"] and all(d["security_checks"].values()) else ("fail" if d["security_checks"] else "n/a")))'
docker run --rm --user 0 -v "$results:/results" "$helper" -c "$python_cmd" /results/results.json
echo "Results retained at: $results"; exit "$client_exit"
