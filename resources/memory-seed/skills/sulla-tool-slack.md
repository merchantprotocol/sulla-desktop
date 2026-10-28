---
slug: sulla-tool-slack
label: Use the Sulla slack tools
trigger_when: When you need to inspect Slack users, read a thread, check integration health, or send or edit a Slack message.
trigger_actions: [slack, Sulla slack tool, tool call]
trigger_phrases: [Slack message, Slack thread, send to Slack, Slack user, Slack connection]
scope: [tool-slack]
---

**When:** Use `exec` to dispatch an exact `sulla slack/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"slack"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla slack/connection_health '{}'`: Check Slack integration health and auto-reinitialize if disconnected/unhealthy. Required: none. Optional: reinitializeIfNeeded, recoveryAttempts, recoveryDelayMs, validateAuth, validateDataPull.
- `sulla slack/search_users '{"query":"<query>"}'`: Search Slack users by username, real name, display name, or email. Required: query. Optional: limit.
- `sulla slack/send_message '{"channel":"<channel>","text":"<text>"}'`: Send a new message to a Slack channel. Required: channel, text. Optional: none.
- `sulla slack/thread '{"channel":"<channel>","ts":"<ts>"}'`: Get replies in a Slack thread. Required: channel, ts. Optional: none.
- `sulla slack/unreact '{"channel":"<channel>","ts":"<ts>","reaction":"<reaction>"}'`: Remove a reaction emoji from a Slack message. Required: channel, ts, reaction. Optional: none.
- `sulla slack/update '{"channel":"<channel>","ts":"<ts>","text":"<text>"}'`: Update an existing Slack message. Required: channel, ts, text. Optional: none.
- `sulla slack/user '{"userId":"<userId>"}'`: Get information about a Slack user. Required: userId. Optional: none.
<!-- tools:generated:end -->
**Do:**
1. `sulla slack/connection_health '{}'` to confirm the integration.
2. `sulla slack/search_users '{"query":"<name or email>"}'` to resolve a user.
3. `sulla slack/thread '{"channel":"<channel>","ts":"<timestamp>"}'` to read replies.
4. Prepare the exact channel, resolved recipients and text; ask once with `sulla meta/ask_user_question` and only after **Approve** send that unchanged message with `sulla slack/send_message '{"channel":"<channel>","text":"<text>"}'`. Messages to the human themselves in a DM they asked for need no extra tap.
5. Re-read or update an existing message with its exact channel and timestamp.

**Don't:**
- Don't send or edit outward messages without authorization.
- Don't expose private Slack data in logs or prompts.
