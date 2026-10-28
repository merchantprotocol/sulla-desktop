---
slug: sulla-check-system-resources
label: Find CPU and memory pressure safely
trigger_when: When the VM, Docker, or Desktop is slow, a container is being killed, or something is consuming memory or CPU.
trigger_actions: [check VM health, find memory hog, find CPU hog, diagnose killed container]
trigger_phrases: [something is eating memory, how is the VM running, container keeps getting killed, check CPU, check memory, Docker is slow]
scope: [sulla-vm, tool-docker]
---

**When:** Diagnose resource pressure before stopping anything.

**Do:**
1. Run read-only VM diagnostics through the VM: `sulla meta/exec '{"command":"free -h; printf \"\nCPU\n\"; nproc; uptime; ps -eo pid,ppid,%cpu,%mem,comm --sort=-%mem | head -20"}'`.
2. Inspect container state: `sulla docker/ps '{"all":true}'`.
3. Inspect the named suspect, not every container's full log: `sulla docker/logs '{"container":"<container>","tail":100}'`.
4. If the container is running, inspect its process list: `sulla docker/exec '{"container":"<container>","command":"ps aux"}'`.
5. If host pressure is suspected, first discover host access: `sulla meta/browse_tools '{"query":"exechost"}'`; use `sulla meta/exechost '{"command":"vm_stat; ps -axo pid,pcpu,pmem,comm | sort -k3 -nr | head -20","cwd":"~"}'` only when Administrative Access is enabled.
6. Recommend the smallest reversible action. Stopping a container or killing a process waits for the human's explicit go-ahead.

**Check:** Compare `free`, `uptime`, process percentages, container status, and recent logs. A killed/restarting container should have an explicit exit or OOM signal in its status/log evidence.

**Cleanup:** Leave diagnostic output in chat or the requested project note; do not create scratch files in `/tmp`.

**Traps:** VM `ps` cannot see host processes. Host commands are unavailable until host access is enabled. Never infer an OOM from slowness alone.
