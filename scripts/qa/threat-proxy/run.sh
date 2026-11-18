#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
set -eu
usage() { echo "Usage: $0 [--keep] IMAGE SCENARIO [client options]" >&2; exit 2; }
keep=0
if [ "${1:-}" = --keep ]; then keep=1; shift; fi
[ "$#" -ge 2 ] || usage
image=$1; scenario=$2; shift 2
case "$scenario" in big_download|big_upload|concurrent|llm_prompts|sse_long|websockets|gzip_bomb|many_hosts|blocked_url_check|injection_check|soak) ;; *) usage ;; esac
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 127; }
runid="$(date +%s)-$$"
network="tproxy-oom-$runid"
proxy="tproxy-oom-$runid-proxy"
origin="tproxy-oom-$runid-origin"
client="tproxy-oom-$runid-client"
state="$(mktemp -d "${TMPDIR:-/tmp}/tproxy-oom-$runid.XXXXXX")"
results="$(pwd)/tproxy-oom-results-$runid"
mkdir -p "$state/mitm" "$state/cache" "$state/public" "$state/config" "$state/blocklist" "$results"
chmod 0777 "$state" "$state/mitm" "$state/cache" "$state/public" "$state/config" "$state/blocklist" "$results"
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
cp "$repo_root/services/sulla-threat-proxy/blocklist/urlhaus-default.txt" "$state/blocklist/urlhaus.txt"
cleanup() {
  if [ "$keep" -eq 1 ]; then echo "Kept resources: network=$network state=$state"; return; fi
  docker rm -f "$client" "$origin" "$proxy" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker rmi "tproxy-oom-harness:$runid" >/dev/null 2>&1 || true
  rm -rf -- "$state"
}
trap cleanup EXIT HUP INT TERM
# Never discovers or removes shared containers; only exact per-run names above.
docker build -t "tproxy-oom-harness:$runid" "$(dirname "$0")"
helper="tproxy-oom-harness:$runid"
docker network create "$network" >/dev/null
docker run -d --name "$origin" --network "$network" --network-alias origin --network-alias 02teste.cc "$helper" origin.py >/dev/null
docker run -d --name "$proxy" --network "$network" --user 10010:10010 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 512m --memory-swap 512m -e SULLA_PROXY_MODE=regular \
  -e SULLA_PROXY_STATE_DIR=/var/lib/sulla-threat-proxy \
  -v "$state/mitm:/var/lib/sulla-threat-proxy/mitm" \
  -v "$state/cache:/var/lib/sulla-threat-proxy/cache" \
  -v "$state/public:/var/lib/sulla-threat-proxy/public" \
  -v "$state/config:/var/lib/sulla-threat-proxy/config:ro" \
  -v "$state/blocklist:/var/lib/sulla-threat-proxy/blocklist:ro" "$image" >/dev/null
printf 'scenario,timestamp,stats_mem,stats_limit,memory_current,memory_peak,oom,oom_kill,vmrss,vmhwm\n' > "$results/samples.csv"
docker run -d --name "$client" --network "$network" --user 0 \
  -v "$state/public:/state/public:ro" -v "$results:/results" "$helper" \
  client.py --scenario "$scenario" --proxy http://proxy:8890 --origin http://origin:8080 --ca /state/public/ca-bundle.pem \
  --output "/results/client-$scenario.json" "$@" >/dev/null
client_exit=0
while docker inspect -f '{{.State.Running}}' "$client" 2>/dev/null | grep -q true; do
  stats=$(docker stats --no-stream --format '{{.MemUsage}}' "$proxy" 2>/dev/null || echo unavailable)
  current=$(docker exec "$proxy" cat /sys/fs/cgroup/memory.current 2>/dev/null || echo '')
  peak=$(docker exec "$proxy" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo '')
  events=$(docker exec "$proxy" cat /sys/fs/cgroup/memory.events 2>/dev/null || echo '')
  oom=$(printf '%s\n' "$events" | awk '$1=="oom"{print $2}'); oomkill=$(printf '%s\n' "$events" | awk '$1=="oom_kill"{print $2}')
  rss=$(docker exec "$proxy" awk '/VmRSS:/{print $2}' /proc/1/status 2>/dev/null || echo '')
  hwm=$(docker exec "$proxy" awk '/VmHWM:/{print $2}' /proc/1/status 2>/dev/null || echo '')
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$scenario" "$(date -u +%FT%TZ)" "$stats" '' "$current" "$peak" "$oom" "$oomkill" "$rss" "$hwm" >> "$results/samples.csv"
  sleep 2
done
client_exit=$(docker wait "$client" 2>/dev/null || echo 1)
docker inspect "$proxy" > "$results/proxy-inspect.json" 2>/dev/null || true
python3 "$(dirname "$0")/summary.py" --samples "$results/samples.csv" --inspect "$results/proxy-inspect.json" --client "$results/client-$scenario.json" --scenario "$scenario" --output "$results/results.json"
cat "$results/summary.md"
echo "Results retained at: $results"
exit "$client_exit"
