# AppleScript

Drive native macOS apps via AppleScript. **Shipped today.** Single tool: `sulla applescript/applescript_execute`.

## The tool

```bash
sulla applescript/applescript_execute '{
  "target_app":  "Calendar",
  "action_type": "read",            # "read" or "write" — declare your intent
  "script":      "tell application \"Calendar\" to get name of every calendar"
}'
```

Returns `{ successBoolean, responseString }`.

| Limit | Value |
|-------|-------|
| Timeout | 10 s per script (hardcoded) |
| Output cap | 100 KB |
| `do shell script` | **rejected** — security |
| Single-target rule | the script's `tell application "..."` block must match `target_app` |

## App allowlist — the user gates access

The tool only works for apps the user has **explicitly enabled** in **Computer Use Settings** (in-app UI). The allowlist registry lives at `pkg/rancher-desktop/main/computerUseSettings/appRegistry.ts` and is enforced before execution.

If the user hasn't enabled the app:
```
"Calendar" is not enabled in Computer Use Settings
```

The agent should tell the user to open Computer Use Settings → enable the app → grant macOS Automation permission when prompted.

### Apps in the registry

**Productivity:** Calendar, Reminders, Notes, Contacts
**Communication:** Mail, Messages, FaceTime
**Browsers:** Safari, Google Chrome, Arc
**Media:** Music, Photos, QuickTime Player, Spotify
**System:** Finder, System Events, Terminal, iTerm2, System Settings
**Third-party:** Slack, Things, OmniFocus, Fantastical, Bear

## Permissions model — two layers

1. **Sulla layer:** user enables app in Computer Use Settings
2. **macOS layer:** System Settings → Privacy & Security → **Automation** → Sulla → toggle the app on. macOS prompts on first use.

If macOS denies, the response includes the error. The Computer Use Settings UI shows status (Granted / Denied / Error / Checking) and has a "Test Permissions" button.

## What the agent should know

### Read examples (low risk)
```bash
# Calendar — what's on this week
sulla applescript/applescript_execute '{
  "target_app":"Calendar","action_type":"read",
  "script":"tell application \"Calendar\" to get summary of every event of calendar \"Personal\" whose start date > (current date)"
}'

# Mail — top 10 unread
sulla applescript/applescript_execute '{
  "target_app":"Mail","action_type":"read",
  "script":"tell application \"Mail\" to get subject of (messages 1 thru 10 of inbox whose read status is false)"
}'

# Music — what's playing
sulla applescript/applescript_execute '{
  "target_app":"Music","action_type":"read",
  "script":"tell application \"Music\" to if player state is playing then return name of current track & \" — \" & artist of current track"
}'

# Finder — list files
sulla applescript/applescript_execute '{
  "target_app":"Finder","action_type":"read",
  "script":"tell application \"Finder\" to get name of every file of folder \"Downloads\" of home folder"
}'
```

### Write examples (higher risk — confirm with user first if non-trivial)
```bash
# Reminders — add a task
sulla applescript/applescript_execute '{
  "target_app":"Reminders","action_type":"write",
  "script":"tell application \"Reminders\" to make new reminder at list \"Inbox\" with properties {name:\"Call dentist\", due date:date \"Friday April 25, 2026 9:00 AM\"}"
}'

# Mail — compose (does NOT auto-send unless explicit)
sulla applescript/applescript_execute '{
  "target_app":"Mail","action_type":"write",
  "script":"tell application \"Mail\" to set newMsg to make new outgoing message with properties {subject:\"Hi\", content:\"Hello\", visible:true}\nset addrs to make new to recipient at end of to recipients of newMsg with properties {address:\"x@y.com\"}\nactivate"
}'

# Slack — set status
sulla applescript/applescript_execute '{
  "target_app":"Slack","action_type":"write",
  "script":"tell application \"System Events\" to tell process \"Slack\" to set status to \"In a meeting\""
}'
```

### High-risk (confirm explicitly)
- **System Events keystroke / click:** equivalent to a user at the keyboard. Can type into anything, click any UI element. Tell the user before doing this.
- **Terminal / iTerm2 commands:** runs whatever shell command the script contains. Treat like running shell on the user's machine.
- **Mail / Messages send:** can impersonate the user. Compose-and-show is safer than compose-and-send-now — let the user click Send.
- **Finder file operations:** can move / delete / copy. Confirm destructive moves.

## Common requests

### "Add this to my calendar"
Parse the user's intent into start/end ISO times and a title. Use the AppleScript above. **Or** — prefer the `sulla calendar/calendar_create` tool, which writes to Sulla's own DB and routes through the scheduler. Use AppleScript only when the user explicitly wants the event in macOS Calendar (which then syncs via iCloud / Google).

### "Send a quick email to X"
Compose with `visible:true` so the user reviews before sending. Don't auto-send unless the user said "send it now."

### "What song is playing?"
The Music / Spotify read scripts above. Quick win.

### "Open this file"
```bash
sulla applescript/applescript_execute '{
  "target_app":"Finder","action_type":"write",
  "script":"tell application \"Finder\" to open POSIX file \"/Users/.../doc.pdf\""
}'
```

### "Toggle Dark Mode"
```bash
sulla applescript/applescript_execute '{
  "target_app":"System Events","action_type":"write",
  "script":"tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode"
}'
```

### "What's in my Reminders?"
```bash
sulla applescript/applescript_execute '{
  "target_app":"Reminders","action_type":"read",
  "script":"tell application \"Reminders\" to get name of every reminder of list \"Inbox\" whose completed is false"
}'
```

## Error handling

Always inspect `successBoolean` before using `responseString`. Common failure modes:

| Error | Cause | Fix |
|-------|-------|-----|
| `Unknown application: ...` | Not in registry | Tell user; can't use this app |
| `"X" is not enabled in Computer Use Settings` | User hasn't enabled it | Direct user to Computer Use Settings |
| `AppleScript error: ...` | Syntax/runtime error | Fix the script |
| `Both target_app and script are required` | Missing param | Fix the call |
| Timeout (10s) | Long-running script | Split into smaller scripts |
| macOS permission denied | Automation perm not granted | Direct user to System Settings → Privacy & Security → Automation |

## Hard rules

- **`do shell script` is rejected.** Don't try.
- **`with administrator privileges` is rejected.** Same.
- **Single target app per call** — your `tell application "..."` must match `target_app`.
- **Don't use Sulla as a privilege-escalation shortcut.** AppleScript is for app automation, not for bypassing security boundaries.
- **Output is capped at 100KB** — for big reads (all emails, all files), paginate or filter.

## Relationship to other tools

- For **macOS Calendar specifically:** `sulla calendar/*` writes to Sulla's own DB, not macOS Calendar. AppleScript writes to macOS Calendar. Pick based on user intent.
- For **browser automation:** use `sulla browser/*` tools (CDP-based) instead of AppleScript controlling Safari/Chrome — far more reliable.
- For **shell commands inside Lima:** use `exec` directly. AppleScript runs on the **host macOS**, not in Lima.

## Reference

- Tool: `pkg/rancher-desktop/agent/tools/applescript/applescript_execute.ts`
- Manifest: `pkg/rancher-desktop/agent/tools/applescript/manifests.ts`
- App registry: `pkg/rancher-desktop/main/computerUseSettings/appRegistry.ts`
- Computer Use Settings UI: see `desktop/computer-use.md`
