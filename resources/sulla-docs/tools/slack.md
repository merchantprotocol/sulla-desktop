# Slack

Slack integration via Web API + Socket Mode. Auth uses **two tokens** — a bot token (`xoxb-`) and an app-level token (`xapp-`). Both must be in the vault.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla slack/send_message` | Post a new message to a channel (or to a user ID, see below) |
| `sulla slack/update` | Edit an existing message |
| `sulla slack/thread` | Get replies in a thread |
| `sulla slack/search_users` | Find users by name / email / display name |
| `sulla slack/user` | Get full info on one user |
| `sulla slack/unreact` | Remove an emoji reaction |
| `sulla slack/connection_health` | Health check + auto-recovery |

Slack's per-scope command tools (`slack_cmd_*`, 48 of them in `tools/slack/slack_scope_commands.ts`) are not in the live `browse_tools` output for Slack. Don't assume they exist; check `browse_tools` first.

## Auth — what the user must connect

The vault entry under `account_type: "slack"` needs:
- `bot_token` — `xoxb-...` (Bot User OAuth Token)
- An app-level token, `xapp-...`, stored under `scopes_token`, `app_token` or `app_level_token`. Socket Mode uses it.

Common gotcha: tokens swapped at config time. The code auto-detects a bot/app prefix mismatch and corrects it, but a missing token silently breaks the connection.

To check connection from the agent:
```bash
sulla slack/connection_health '{}'
```
Returns: registry status, `auth.test` API result, `users.list(limit=1)` data pull, and recovery attempt count. On failure it invalidates the cached client and retries (3 attempts, 1.5s delay by default). Params `recoveryAttempts`, `recoveryDelayMs`, `validateAuth`, `validateDataPull` override the defaults.

## Required scopes (per tool)

Slack scopes are app-level — set when the user installs the bot to their workspace. Common ones:

| Scope | Enables |
|-------|---------|
| `chat:write` | `slack/send_message`, `slack/update` |
| `channels:history` | Read public channel history (needed by `slack/thread` for public channels) |
| `groups:history` | Same for private channels |
| `im:history` | Same for DMs |
| `users:read` | `slack/search_users`, `slack/user` |
| `users.profile:read` | Full profile fields on `slack/user` |
| `reactions:write` | `slack/unreact` |

If a tool returns a `missing_scope` error, the user needs to reinstall the app with the additional scope.

## Common patterns

### Send to a channel
```bash
sulla slack/send_message '{
  "channel": "C0123456789",
  "text":    "Deploy completed for sulla-workers"
}'
```
`send_message` takes only `channel` and `text`. It cannot reply in a thread. See "Thread replies" below.

### DM a user (find first, then send)
DM channels are `D...` prefixed, not `C...`. Look up the user ID, then send to it:
```bash
sulla slack/search_users '{"query":"jane@company.com","limit":1}'
# returns: [{"id":"U0123","real_name":"Jane Doe","email":"jane@company.com",...}]
sulla slack/send_message '{"channel":"U0123","text":"Quick FYI"}'
```

### Get thread replies
```bash
sulla slack/thread '{"channel":"C0123","ts":"1719283859.123456"}'
```
`ts` is the parent message's timestamp. The send response returns it.

### Edit a message
```bash
sulla slack/update '{
  "channel": "C0123",
  "ts":      "1719283859.123456",
  "text":    "Updated: deploy actually rolled back"
}'
```

### Find a user by email or display name
```bash
sulla slack/search_users '{"query":"jonathon","limit":5}'
```
Searches across username, real_name, display_name, email. Default limit is 10.

### Thread replies
`slack/send_message` has no `thread_ts` parameter, so the agent cannot post a thread reply today. `SlackClient` has `replyInThread` internally. Until the tool exposes it, say so when a task needs a thread reply instead of posting to the channel.

## Limits

- **Message text:** `text` is sent as Slack mrkdwn. The tool does not expose blocks or attachments.
- **Thread depth:** unlimited backend, but Slack UI scroll degrades past ~100 replies.
- **Rate limits:** Slack tier 1–4 enforced server-side. Tools don't proactively back off — concurrent sends can hit `ratelimited`. Space them out.
- **Token expiry:** not auto-detected. Health check catches it; no proactive warning.

## Common requests

### "Send a Slack message to #engineering"
1. Get the channel ID. The tools take IDs, not names, and there is no channel-list tool in the live catalog.
2. `sulla slack/send_message '{"channel":"C...","text":"..."}'`

### "Notify the team when X finishes"
Combine with presence: if the user is here, just respond in chat. If they're away **and** want team-wide visibility, `slack/send_message` to a channel.

### "Is Slack working?"
```bash
sulla slack/connection_health '{}'
```

### "DM Jane the report"
1. `slack/search_users` with her name/email
2. `slack/send_message` to her user ID

## Hard rules

- **Never paste credentials in messages.** Slack messages are visible to everyone in the channel — even ephemeral content can be screenshotted.
- **Don't loop mass sends.** Sending dozens of DMs in a loop gets the bot removed from workspaces.
- **Don't impersonate.** The bot speaks as itself ("Sulla Bot"), not as the user. Don't word messages as if the human wrote them — be transparent.
- **Watch for scope errors.** `missing_scope` means the app needs reinstall with new scopes — only the user can do that.

## Reference

- Tool dir: `pkg/sulla-desktop/agent/tools/slack/`
- Manifest: `pkg/sulla-desktop/agent/tools/slack/manifests.ts`
- Client: `pkg/sulla-desktop/agent/integrations/slack/SlackClient.ts`
- Credential properties: `pkg/sulla-desktop/agent/integrations/index.ts`
