# bridge tools

Bidirectional communication bridge between the heartbeat (autonomous background agent) and the frontend (human-facing chat). Send messages, read messages, update and read human presence state.

## get_human_presence

Read the current human presence state from Redis. Returns whether the human is available, what they are viewing, their activity, and how long since they were last seen.

**Parameters**

None.

**Example**

```bash
sulla bridge/get_human_presence '{}'
```

## update_human_presence

Update the human presence state in Redis. Call this to inform other agents about what the human is currently viewing, doing, or whether they are available.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `available` | boolean | Optional |
| `current_view` | string | Optional |
| `current_activity` | string | Optional |
| `active_channel` | string | Optional |

**Example**

```bash
sulla bridge/update_human_presence '{}'
```
