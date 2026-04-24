# Slack

Slack integration via Web API + Socket Mode. Auth uses **two tokens** — a bot token (`xoxb-`) and an app token (`xapp-`). Both must be in the vault.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla slack/slack_send_message` | Post to a channel (or DM) |
| `sulla slack/slack_update` | Edit an existing message |
| `sulla slack/slack_thread` | Get replies in a thread |
| `sulla slack/slack_search_users` | Find users by name / email / display name |
| `sulla slack/slack_user` | Get full info on one user |
| `sulla slack/slack_unreact` | Remove an emoji reaction |
| `sulla slack/slack_connection_health` | Health check + auto-recovery |
| `sulla slack/slack_scope_commands` | 50+ dynamically generated tools per Slack API scope |

## Auth — what the user must connect

The vault entry under `account_type: "slack"` needs (at minimum):
- `bot_token` — `xoxb-...` (Bot User OAuth Token)
- `scopes_token` (or fallback `app_token` / `app_level_token`) — `xapp-...` (App-level token for Socket Mode)

Common gotcha: tokens swapped at config time. The code auto-detects bot/app prefix mismatch and corrects, but missing either token silently breaks the connection.

To check connection from the agent:
```bash
sulla slack/slack_connection_health '{}'
```
Returns: registry status, `auth.test` API result, `users.list(limit=1)` data pull, and recovery attempt count. Auto-invalidates the cached client on failure (3 attempts, 1.5s delay).

## Required scopes (per tool)

Slack scopes are app-level — set when the user installs the bot to their workspace. Common ones:

| Scope | Enables |
|-------|---------|
| `chat:write` | `slack_send_message`, `slack_update` |
| `channels:history` | Read public channel history (needed by `slack_thread` for public channels) |
| `groups:history` | Same for private channels |
| `im:history` | Same for DMs |
| `users:read` | `slack_search_users`, `slack_user` |
| `users.profile:read` | Full profile fields on `slack_user` |
| `reactions:write` | `slack_unreact` (and add-reaction in scope_commands) |

If a tool returns an `missing_scope` error, the user needs to reinstall the app with the additional scope.

## Common patterns

### Send to a channel
```bash
sulla slack/slack_send_message '{
  "channel": "C0123456789",
  "text":    "Deploy completed for sulla-workers"
}'
```
Returns `{ts, channel, ...}` — the `ts` is the message timestamp, which doubles as the parent for thread replies.

### DM a user (find first, then send)
DM channels are `D...` prefixed, not `C...`. Open one by sending to the user ID:
```bash
sulla slack/slack_search_users '{"query":"jane@company.com","limit":1}'
# returns: [{"id":"U0123","real_name":"Jane Doe","email":"jane@company.com",...}]
sulla slack/slack_send_message '{"channel":"U0123","text":"Quick FYI"}'
# Slack auto-opens the DM channel for the user ID
```

### Reply in a thread
```bash
sulla slack/slack_send_message '{
  "channel":  "C0123",
  "text":     "Following up",
  "thread_ts":"1719283859.123456"
}'
```
`thread_ts` is the parent message's `ts` — get it from the original send response or from `slack_thread`.

### Get thread replies
```bash
sulla slack/slack_thread '{"channel":"C0123","ts":"1719283859.123456"}'
```

### Edit a message
```bash
sulla slack/slack_update '{
  "channel": "C0123",
  "ts":      "1719283859.123456",
  "text":    "Updated: deploy actually rolled back"
}'
```

### Find a user by email or display name
```bash
sulla slack/slack_search_users '{"query":"jonathon","limit":5}'
```
Searches across username, real_name, display_name, email.

## Limits

- **Message text:** ~4000 chars for `text` field. (Slack supports 16KB+ via `blocks`, but the tool schema is text-only today — no rich blocks / attachments.)
- **Thread depth:** unlimited backend, but Slack UI scroll degrades past ~100 replies.
- **Search default:** 10 users; pass `limit` to widen.
- **Rate limits:** Slack tier 1–4 enforced server-side. Tools don't proactively back off — concurrent sends can hit `ratelimited`. Space them out.
- **Token expiry:** not auto-detected. Health check catches it; no proactive warning.

## Common requests

### "Send a Slack message to #engineering"
1. Confirm the channel ID with the user (or use `users:read`/`channels:list` to look up by name — that requires a scope_command tool).
2. `sulla slack/slack_send_message '{"channel":"C...","text":"..."}'`

### "Notify the team when X finishes"
Combine with presence: if the user is here, just respond in chat. If they're away **and** want team-wide visibility, `slack_send_message` to a channel.

### "Is Slack working?"
```bash
sulla slack/slack_connection_health '{}'
```

### "DM Jane the report"
1. `slack_search_users` with her name/email
2. `slack_send_message` to her user_id

### "Reply to that thread"
Get the parent `ts` from earlier context. Send with `thread_ts`.

## Hard rules

- **Never paste credentials in messages.** Slack messages are visible to everyone in the channel — even ephemeral content can be screenshotted.
- **Confirm before mass-sending.** A loop sending 50 DMs is technically possible and a great way to get the bot kicked out.
- **Don't impersonate.** The bot speaks as itself ("Sulla Bot"), not as the user. Don't word messages as if the human wrote them — be transparent.
- **Watch for scope errors.** `missing_scope` means the app needs reinstall with new scopes — only the user can do that.

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/slack/`
- Manifest: `pkg/rancher-desktop/agent/tools/slack/manifests.ts`
- Service: `pkg/rancher-desktop/agent/services/slack/` (SlackClient, factory, registry)
- Auth properties in vault: `bot_token`, `scopes_token` (or `app_token` / `app_level_token`)
