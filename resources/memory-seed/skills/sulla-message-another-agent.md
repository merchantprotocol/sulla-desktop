---
slug: sulla-message-another-agent
label: Message another Sulla agent
trigger_when: When you need to notify or coordinate with another live agent.
trigger_actions: [message another agent, notify heartbeat, send channel update]
trigger_phrases: [message heartbeat, tell the other agent, channel message, notify an agent]
scope: [sulla-channels]
---

**When:** Send a short asynchronous update to a known channel.

**Do:**
1. Read the current roster and channel from `<turn_context>`.
2. Emit a tag in your reply, such as `<channel:heartbeat>The scan is ready for review.</channel:heartbeat>`.
3. Continue useful work. Do not wait or poll.

**Tools:** No tool call is needed. The runtime detects and routes channel XML tags.

**Don't:**
- Invent a channel name or recipient.
- Put secrets in channel messages.
- Treat no reply as proof the recipient failed.
