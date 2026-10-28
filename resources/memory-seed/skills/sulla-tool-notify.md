---
slug: sulla-tool-notify
label: Use the Sulla notify tools
trigger_when: When you need to send desktop/mobile notifications or inspect notification history.
trigger_actions: [notify, Sulla notify tool, tool call]
trigger_phrases: [notify]
scope: [tool-notify]
---

**When:** Use `exec` to dispatch an exact `sulla notify/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"notify"}'` before an unfamiliar call.

**Tools:**
- `sulla notify/user '{"title":"<title>","message":"<message>"}'`: Send a notification to the user. Default target is "desktop" (native macOS / Notification Center). Pass targets:["mobile"] to push to the paired phone via the Sulla Cloud relay, or targets:["desktop","mobile"] to fan out. Every call is logged to `notifications` — query via notify/history. Required: title, message.
- `sulla notify/history '{}'`: Read the notification history. Every notify_user call writes a row with title, message, targets, delivered flag, and any error. Filter by target ("desktop" | "mobile"), only_failures, and/or since (ISO timestamp). Required: none.

**Do:**
1. Discover the category when names or parameters may have changed.
2. Run the command through `exec`, passing one JSON object with required parameters.
3. Treat returned IDs, cursors, and SHAs as inputs to the next call; verify destructive or outward-facing results.

**Don't:**
- Don't notify or target mobile for routine work without a reason.
- Don't put secrets or private data in notification text.
