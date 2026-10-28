---
slug: sulla-tool-notify
label: Use the Sulla notify tools
trigger_when: When you need to send a desktop or mobile notification or inspect notification history.
trigger_actions: [notify, Sulla notify tool, tool call]
trigger_phrases: [desktop notification, mobile notification, notify me, notification history, failed notifications, let me know if, if anything fails, overnight, ping me]
scope: [tool-notify]
---

**When:** Use `exec` to dispatch an exact `sulla notify/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"notify"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla notify/history '{}'`: Read the notification history. Every notify_user call writes a row with title, message, targets, delivered flag, and any error. Filter by target ("desktop" | "mobile"), only_failures, and/or since (ISO timestamp). Required: none. Optional: limit, target, only_failures, since.
- `sulla notify/user '{"title":"<title>","message":"<message>"}'`: Send a notification to the user. Default target is "desktop" (native macOS / Notification Center). Pass targets:["mobile"] to push to the paired phone via the Sulla Cloud relay, or targets:["desktop","mobile"] to fan out. Every call is logged to `notifications` — query via notify/history. Required: title, message. Optional: targets, id, silent.
<!-- tools:generated:end -->
**Do:**
1. `sulla notify/history '{"only_failures":true}'` to inspect delivery failures.
2. `sulla notify/user '{"title":"<title>","message":"<message>","targets":["desktop"]}'` to notify the desktop.
3. Add `"mobile"` to `targets` only when the user needs the paired phone.

**Don't:**
- Don't send routine or noisy notifications.
- Don't put secrets or private data in notification text.
