---
slug: sulla-tool-slack
label: Use the Sulla slack tools
trigger_when: When you need to read or send Slack messages.
trigger_actions: [slack, Sulla slack tool, tool call]
trigger_phrases: [slack]
scope: [tool-slack]
---

**When:** Use `exec` to dispatch an exact `sulla slack/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"slack"}'` before an unfamiliar call.

**Tools:**
- `sulla slack/connection_health '{}'`: Check Slack integration health and auto-reinitialize if disconnected/unhealthy. Required: none.
- `sulla slack/search_users '{"query":"<query>"}'`: Search Slack users by username, real name, display name, or email. Required: query.
- `sulla slack/send_message '{"channel":"<channel>","text":"<text>"}'`: Send a new message to a Slack channel. Required: channel, text.
- `sulla slack/thread '{"channel":"<channel>","ts":"<ts>"}'`: Get replies in a Slack thread. Required: channel, ts.
- `sulla slack/unreact '{"channel":"<channel>","ts":"<ts>","reaction":"<reaction>"}'`: Remove a reaction emoji from a Slack message. Required: channel, ts, reaction.
- `sulla slack/update '{"channel":"<channel>","ts":"<ts>","text":"<text>"}'`: Update an existing Slack message. Required: channel, ts, text.
- `sulla slack/user '{"userId":"<userId>"}'`: Get information about a Slack user. Required: userId.

**Do:**
1. Discover the category when names or parameters may have changed.
2. Run the command through `exec`, passing one JSON object with required parameters.
3. Treat returned IDs, cursors, and SHAs as inputs to the next call; verify destructive or outward-facing results.

**Don't:**
- Don't send, edit, or remove reactions as a read operation; outward messages need explicit authorization.
- Don't expose private Slack data in logs or prompts.
