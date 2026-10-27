# slack tools

Slack messaging and reaction tools.

## connection_health

Check Slack integration health and auto-reinitialize if disconnected/unhealthy.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `reinitializeIfNeeded` | boolean | Optional |
| `recoveryAttempts` | number | Optional |
| `recoveryDelayMs` | number | Optional |
| `validateAuth` | boolean | Optional |
| `validateDataPull` | boolean | Optional |

**Example**

```bash
sulla slack/connection_health '{}'
```

## search_users

Search Slack users by username, real name, display name, or email.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Required |
| `limit` | number | Optional |

**Example**

```bash
sulla slack/search_users '{"query":"<query>"}'
```

## send_message

Send a new message to a Slack channel.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `channel` | string | Required |
| `text` | string | Required |

**Example**

```bash
sulla slack/send_message '{"channel":"<channel>","text":"<text>"}'
```

## thread

Get replies in a Slack thread.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `channel` | string | Required |
| `ts` | string | Required |

**Example**

```bash
sulla slack/thread '{"channel":"<channel>","ts":"<ts>"}'
```

## unreact

Remove a reaction emoji from a Slack message.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `channel` | string | Required |
| `ts` | string | Required |
| `reaction` | string | Required |

**Example**

```bash
sulla slack/unreact '{"channel":"<channel>","ts":"<ts>","reaction":"<reaction>"}'
```

## update

Update an existing Slack message.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `channel` | string | Required |
| `ts` | string | Required |
| `text` | string | Required |

**Example**

```bash
sulla slack/update '{"channel":"<channel>","ts":"<ts>","text":"<text>"}'
```

## user

Get information about a Slack user.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `userId` | string | Required |

**Example**

```bash
sulla slack/user '{"userId":"<userId>"}'
```
