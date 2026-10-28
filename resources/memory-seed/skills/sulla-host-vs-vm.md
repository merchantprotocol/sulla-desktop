---
slug: sulla-host-vs-vm
label: Choose between the Sulla VM and host execution
trigger_when: When a command, file, app, Docker daemon, or service might live on the host rather than inside the Sulla VM.
trigger_actions: [run a shell command, access a host app, use exechost, inspect Docker, reach a host service]
trigger_phrases: [host machine, exechost, Sulla VM, Mac, Docker Desktop, host path]
scope: [sulla-vm]
---

**When:** Decide where a command must execute without exposing or modifying the host unnecessarily.

**Do:**
1. Run ordinary shell, search, edit, build, Git, and Sulla CLI work with VM `exec`.
2. Check whether the need is already met through `/mnt/sulla-files`, `/mnt/worktrees`, or gateway `192.168.5.2`.
3. If it is truly host-only, inspect the live tool: `sulla meta/browse_tools '{"query":"exechost"}'`.
4. Run the smallest host command with `sulla meta/exechost '{"command":"<command>","cwd":"<host-directory>"}'`.
5. Return to VM execution immediately afterward.

**Don't:**
- Don't use host execution merely because a path originated on the host.
- Don't open Terminal through AppleScript.
- Don't put durable work in `/tmp`, `/`, or the VM home directory.
