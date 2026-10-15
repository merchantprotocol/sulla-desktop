# Agent Patterns — Inter-Agent Channels

## Active Channels

| Channel | Agent | Purpose |
|---------|-------|---------|
| `sulla-desktop` | Frontend chat agent | Primary user-facing chat |
| `heartbeat` | Autonomous heartbeat agent | Background autonomous tasks |
| `mobile-relay` | Sulla Mobile | Chat routed from paired mobile device |

---

## Sending a Message to Another Agent

Wrap your message in an XML tag named after the target channel:

```
<channel:heartbeat>Are you online? Reply when ready.</channel:heartbeat>

<channel:sulla-desktop>The daily report is ready. Summary: [...]</channel:sulla-desktop>
```

The system detects these tags and routes them automatically. **No tool call needed.**

---

## Fire-and-Forget Rules

- After sending a channel message, **continue your work immediately**
- Do NOT poll or wait for a reply
- Do NOT check for responses — they arrive on your channel when ready
- If no reply comes, the agent hasn't responded. Try again later or move on.

**Wrong:**
```
Send message to heartbeat → wait → check for reply → wait more
```

**Right:**
```
Send message to heartbeat → continue doing other work
```

---

## Message Format

Messages are plain text inside the channel tag. Include enough context for the receiving agent to act:

```
<channel:sulla-desktop>
The daily-social-posts workflow status is ready for review.
</channel:sulla-desktop>
```

---

## Your Channel

When responding to a message from another agent, include your sender identity in the content so they know who replied. Your channel is visible in the system context.

---

## Notification to Human

To notify Jonathon (the human):

```bash
exec({ command: "sulla notify/notify_user '{\"title\":\"Task Complete\",\"message\":\"Social posts generated for today.\"}'" })
```

This sends a desktop notification. Also fire-and-forget.

---

## Redis Presence (Agent State)

Check if the human is currently active:
```bash
exec({ command: "sulla bridge/get_human_presence '{}'" })
```

Returns: `{ available, current_view, current_activity, active_channel, idle_since }`

Update your own presence:
```bash
exec({ command: "sulla bridge/update_human_presence '{\"available\":true,\"current_activity\":\"generating social posts\"}'" })
```
