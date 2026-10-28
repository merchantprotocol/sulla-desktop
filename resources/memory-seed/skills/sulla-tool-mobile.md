---
slug: sulla-tool-mobile
label: Use the Sulla Mobile tools
trigger_when: When you need to use Sulla Mobile operations.
trigger_actions: [mobile, mobile tools]
trigger_phrases: [mobile, mobile]
scope: [tool-mobile]
---

**When:** When you need to use Sulla Mobile operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# mobile tools

Sulla Mobile companion — check whether signed-in desktop and mobile devices are reachable.

## list_devices

List every desktop and mobile device registered to the account, annotated with online/offline status. A device is "online" when it has hit the worker within the last 2 minutes (heartbeat or any authenticated call).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `online_only` | boolean | Optional |
| `device_type` | enum: desktop\|mobile | Optional |

**Example**

```bash
sulla mobile/list_devices '{}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
