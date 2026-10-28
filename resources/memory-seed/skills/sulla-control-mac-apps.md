---
slug: sulla-control-mac-apps
label: Control supported Mac apps safely
trigger_when: When the human asks to use Reminders, Calendar, Notes, Finder, Music, or another supported macOS app through Sulla.
trigger_actions: [add reminder, open Finder folder, inspect Mac app, run AppleScript recipe]
trigger_phrases: [add this to Reminders, open this folder in Finder, use Calendar on my Mac, write a Note, control a Mac app]
scope: [tool-applescript, sulla-vm]
---

**When:** Use the AppleScript tool for supported app actions; ordinary shell work stays in the VM.

**Do:**
1. Check prior outcomes: `sulla applescript/audit_log '{"limit":20}'`.
2. For a safe Finder read, run `sulla applescript/execute '{"target_app":"Finder","script":"tell application \"Finder\" to get name of startup disk","action_type":"read"}'`.
3. For a read-only folder reveal, use `sulla applescript/execute '{"target_app":"Finder","script":"tell application \"Finder\" to POSIX file \"<host path>\"","action_type":"read"}'`; if the requested path exists only in the VM, explain the boundary instead.
4. For a Reminder, prepare a write script targeting `Reminders` with title, list, and due date; ask for explicit approval immediately before `action_type":"write"`.
5. For Calendar, Notes, Music, or Finder writes, use the same pattern: explicit `target_app`, minimal script, `action_type":"write"`, approval, then audit log.
6. If access fails, inspect `sulla applescript/audit_log '{"only_failures":true,"limit":20}'` and explain that Administrative Access or macOS app permission may be required.

**Check:** Read the created item or audit log after a write. Never claim success from a command that returned an error.

**Cleanup:** Do not delete app data or close apps unless explicitly approved. AppleScript runs in the background by default; set `foreground:true` only when a UI interaction truly requires it and the human is idle.

**Traps:** AppleScript cannot control the human's Chrome tabs through Sulla's built-in browser. Do not open Terminal via AppleScript.
