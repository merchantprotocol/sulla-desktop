# notify tools

Send desktop notifications to alert the user when async work completes or needs attention.

## history

Read the notification history. Every notify_user call writes a row with title, message, targets, delivered flag, and any error.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `limit` | number | Optional |
| `target` | string | Optional |
| `only_failures` | boolean | Optional |
| `since` | string | Optional |

**Example**

```bash
sulla notify/history '{}'
```

## user

Send a notification to the user. Default target is "desktop" (native macOS / Notification Center).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `title` | string | Required |
| `message` | string | Required |
| `targets` | array | Optional |
| `id` | string | Optional |
| `silent` | boolean | Optional |

**Example**

```bash
sulla notify/user '{"title":"<title>","message":"<message>"}'
```
