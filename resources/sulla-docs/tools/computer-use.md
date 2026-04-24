# Computer Use

**The honest summary:** Sulla today has **AppleScript-mediated app control** with a per-app permissions UI called "Computer Use Settings." Full pixel-level computer use (Anthropic-style screenshot + click + keyboard at the OS level) is **designed but not yet shipped as agent tools**.

Don't tell the user "I can control your screen" if they meant the Anthropic-style ability — that's the planned Phase 2/3 capability described below. Tell them what's actually wired.

## What's shipped today

### AppleScript-mediated app control
The agent can drive any app on the macOS allowlist via AppleScript:
- See `tools/applescript.md` for the tool itself
- Allowlist managed by the user in **Computer Use Settings** (in-app UI)
- App registry: `pkg/rancher-desktop/main/computerUseSettings/appRegistry.ts`
- Two permission layers: (1) user enables app in Sulla settings, (2) macOS Automation permission per app

This covers most "control my Mac" requests as long as the target is a real app with AppleScript support: Calendar, Reminders, Notes, Mail, Messages, Finder, Music, Spotify, Slack, System Events, Terminal, etc.

### Browser-internal pixel control
Inside Sulla's browser tabs, the agent CAN do screenshot + click-at-coords + type-at-coords via CDP — see `tools/browser.md` (`screenshot`, `click_at`, `type_at`, `hover`). **This works only inside Sulla's browser views, not OS-level windows.**

## What's NOT shipped (planned)

Per `docs/feature-requests/computer-use-agent.md`, the full computer-use stack is designed in phases:

### Phase 1 — Grid overlay + screenshot loop
A transparent Electron BrowserWindow overlays the full screen with a labeled coordinate grid every 200px. Grid shows for ~100ms during capture, hides afterward. Screenshot captures the macOS desktop including the grid.

### Phase 2 — Native input via CGEvent
Native Node addon (or `@nut-tree/nut-js`) wraps macOS Core Graphics `CGEvent` for: mouse move, click (left/right/double), drag, keyboard typing, key combos, scroll. System-level — works with any app, no per-app special handling.

### Phase 3 — Agent integration
New tools planned: `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`. Schema mirrors Anthropic's computer use format. Agent loop: observe screenshot → return action → engine executes → repeat. Confirmation UI before each action; kill switch (Cmd+Shift+Esc).

### Phase 4 — Polish
Multi-display support, restricted regions, action logging with before/after screenshots, rate limiting, cursor indicator.

### Required permissions (when shipped)
- **Screen Recording** — for full desktop captures (Sulla may already have it for Capture Studio)
- **Accessibility** — for `CGEvent`-based input (System Settings → Privacy & Security → Accessibility)

## What this means for user requests today

| User says | Agent should... |
|----------|-----------------|
| "Open this PDF in Preview" | Use AppleScript on Finder/Preview |
| "Add a reminder for tomorrow" | AppleScript on Reminders, OR `calendar/calendar_create` (different destination — confirm intent) |
| "What song is playing?" | AppleScript on Music or Spotify |
| "Click the button on this webpage" | `browser/click` (handle) or `browser/click_at` (coords) — works because it's inside Sulla's browser |
| "Take a screenshot of my whole screen" | **Not yet.** Tell user it's planned. Workaround: `sulla applescript/applescript_execute` with `screencapture` shell command — but `do shell script` is blocked. Best workaround: ask user to take it themselves and paste. |
| "Click the menu bar / Dock / a non-Sulla app's window" | **Not yet.** Phase 3 will enable this. AppleScript on System Events has limited UI scripting that may help in some cases. |
| "Move my mouse to (x, y) on the desktop" | **Not yet.** Phase 2. |
| "Type into TextEdit" | **Not yet** — at least not via a clean computer-use tool. Could attempt via System Events keystroke (high-risk, prompts user). |

## When the user asks "Can you control my Mac?"

Be honest:

> "I can drive any of your macOS apps that have AppleScript support — Calendar, Mail, Reminders, Notes, Finder, Music, Slack, and a bunch more — as long as you've enabled them in Computer Use Settings. I can also click and type inside webpages I'm browsing. Full screen-capture + mouse-click-anywhere on the desktop is designed but not shipped yet."

Then ask what they actually want to do — most "control my Mac" requests turn out to be fine within AppleScript or browser tools.

## The "Computer Use Settings" UI

Lives in the Sulla Desktop app. The user toggles individual apps on/off and the UI surfaces macOS permission status. The agent has **no tool to open this settings UI today** (UI navigation gap — see `agent-patterns/known-gaps.md`).

Tell the user to open it manually. Once shipped, this would be `sulla ui/open_tab '{"mode":"settings","section":"computer-use"}'` or similar.

## Hard rules

- **Don't pretend computer use exists.** If the request needs OS-level pixel clicks outside the browser and outside AppleScript, say so.
- **AppleScript ≠ unlimited Mac control.** It's app-scoped, requires per-app user opt-in, and has security guards (no `do shell script`, no `administrator privileges`).
- **Watch the user when running risky AppleScripts** — especially System Events keystroke or anything against Mail/Messages/Terminal. Use `bridge/get_human_presence` to check if they're at the keyboard before high-risk writes.

## Reference

- AppleScript tool docs: `tools/applescript.md`
- App registry: `pkg/rancher-desktop/main/computerUseSettings/appRegistry.ts`
- Computer-use design doc: `docs/feature-requests/computer-use-agent.md`
- Browser pixel-control (works today): `tools/browser.md` (`click_at`, `type_at`, `hover`, `screenshot`)
