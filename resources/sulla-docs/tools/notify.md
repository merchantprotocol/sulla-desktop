# Notifications

How the agent gets the user's attention when they're not looking at the chat.

## Two notification surfaces

1. **System notification** (macOS Notification Center / native) — fired by `notify_user`
2. **Heartbeat window** (custom frameless Electron, top-right) — fired by the heartbeat agent automatically when its run completes

The agent only fires #1 directly. #2 is owned by the HeartbeatService.

## `notify_user`

```bash
sulla notify/notify_user '{
  "title": "Build complete",
  "message": "Workflow shipped, all green",
  "id": "build-1234",      // optional, auto-generated if omitted
  "silent": false          // optional, default false
}'
```

Implementation routes to `chrome.notifications.create()` → host IPC → macOS Notification Center.

## Presence — knowing whether to interrupt

Before firing a proactive notification, check whether the user is even at the keyboard:

```bash
sulla bridge/get_human_presence '{}'
```

Returns:
```json
{
  "available": true,
  "lastSeen": 1719283859000,
  "currentView": "Agent Chat",
  "currentActivity": "chatting with agent",
  "activeChannel": "sulla-desktop",
  "idleMinutes": 3,
  "metadata": {}
}
```

**Decision rule:**
- `idleMinutes < 2` → user is here, just respond in chat. Don't notify.
- `idleMinutes 2–10` → likely at desk, may have switched windows. Notify only if useful.
- `idleMinutes > 10` → user is away. Notify, but make the message self-contained (they'll read it without the chat context).

The agent can also publish its own state with `bridge/update_human_presence` when relevant (e.g., setting `current_activity` so other channel agents know what's happening).

## When to notify (rules of thumb)

✅ Notify when:
- A long-running task you started finishes (build, deploy, scrape)
- A scheduled workflow finishes successfully or fails
- You hit a blocker that needs the user's input AND the user is away
- A monitored event fires (URL went down, calendar reminder, etc.)

❌ Don't notify when:
- The user is actively looking at the chat (`idleMinutes < 2`)
- The result is something they already see in the response
- It's for something trivial they'd find annoying (avoid notification fatigue)

## Format

- **Title:** ≤50 chars, action-summary, no trailing punctuation. "Build complete" not "The build has been completed successfully."
- **Message:** ≤200 chars. Lead with the status, then 1 useful detail. The user reads this without context.
- **id:** Pass when you want to dedupe — multiple ticks of the same job should reuse the same id so the notification updates instead of stacking.
- **silent:** `true` for low-urgency status updates so you don't annoy with sound.

## What's NOT yet supported

- **Mobile delivery.** `notify_user` is desktop-only. There's no mobile relay route for notifications yet. If the user is on their phone, they won't see it.
- **Action buttons.** No reply-from-notification or click-action wiring beyond opening the app.
- **Persistent notifications / banners.** macOS surface only.

## Reference

- Tool manifest: `pkg/rancher-desktop/agent/tools/notify/manifests.ts`
- Implementation: `pkg/rancher-desktop/agent/tools/notify/notify_user.ts`
- Bridge tools: `pkg/rancher-desktop/agent/tools/bridge/manifests.ts`
- Presence service: `pkg/rancher-desktop/agent/services/HumanHeartbeatBridge.ts`
- Heartbeat window: `pkg/rancher-desktop/main/heartbeatNotification.ts`
