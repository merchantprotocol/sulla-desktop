---
slug: sulla-tool-bridge
label: Use the Sulla Bridge tools
trigger_when: When you need to use Sulla Bridge operations.
trigger_actions: [bridge, bridge tools]
trigger_phrases: [bridge, bridge]
scope: [tool-bridge]
---

**When:** When you need to use Sulla Bridge operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

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


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
