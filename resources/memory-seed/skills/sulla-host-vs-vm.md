---
slug: sulla-host-vs-vm
label: Choose between the Sulla VM and host execution
trigger_when: When a command, file, app, Docker daemon, service, or Mac setting might live on the host rather than inside the Sulla VM, or when host access must be enabled.
trigger_actions: [run a shell command, access a host app, use exechost, inspect Docker, reach a host service]
trigger_phrases: [host machine, exechost, Sulla VM, Mac, Docker Desktop, host path, turn on host access, run on my Mac, folder on my Mac]
scope: [sulla-vm]
---

**When:** Decide where a command must execute without exposing or modifying the host unnecessarily.

**Do:**
1. Run ordinary shell, search, edit, build, Git, and Sulla CLI work with VM `exec`.
2. Check whether the need is already met through `/mnt/sulla-files`, `/mnt/worktrees`, or gateway `192.168.5.2`.
3. If it is truly host-only, inspect the live tool: `sulla meta/browse_tools '{"query":"exechost"}'`.
4. Run the smallest host-only command with `sulla meta/exechost '{"command":"<command>","cwd":"<host-directory>"}'`. If it deletes data, kills or removes a host service, changes security or system settings, or is otherwise destructive, show the exact command and its impact and wait for **Approve** through `ask_user_question` first.
5. Check the setting before crossing the boundary: `sulla settings/get '{"property":"application.adminAccess"}'`; if false, direct the human to Preferences → Application → Administrative Access → Allow access to the host machine.
6. Return to VM execution immediately afterward.

**Check:** A host command must return its own result, and `application.adminAccess` must be true before relying on host-only work. A VM path such as `/mnt/sulla-files` is not automatically a Mac path.

**Cleanup:** Keep host commands minimal; do not leave background processes or copies on the host.

**Traps:** VM `exec` cannot see arbitrary host paths, and `exechost` is unavailable when Administrative Access is off.

**Don't:**
- Don't use host execution merely because a path originated on the host.
- Don't open Terminal through AppleScript.
- Don't put durable work in `/tmp`, `/`, or the VM home directory.
