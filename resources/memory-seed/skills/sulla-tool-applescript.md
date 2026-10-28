---
slug: sulla-tool-applescript
label: Use the Sulla Applescript tools
trigger_when: When you need to use Sulla Applescript operations.
trigger_actions: [applescript, applescript tools]
trigger_phrases: [applescript, applescript]
scope: [tool-applescript]
---

**When:** When you need to use Sulla Applescript operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# applescript tools

Execute AppleScript to control macOS applications when Administrative Access is enabled.

## audit_log

Read the AppleScript execution audit log. Every applescript_execute call writes a row with target_app, script, success, duration, and error.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `limit` | number | Optional |
| `target_app` | string | Optional |
| `only_failures` | boolean | Optional |
| `since` | string | Optional |

**Example**

```bash
sulla applescript/audit_log '{}'
```

## execute

Execute AppleScript to interact with macOS applications (Calendar, Reminders, Mail, Notes, Safari, Finder, Music, and more). Always specify the target app name.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `target_app` | string | Required |
| `script` | string | Required |
| `action_type` | enum: read\|write | Required |
| `foreground` | boolean | Optional |

**Example**

```bash
sulla applescript/execute '{"target_app":"<target_app>","script":"<script>","action_type":"<action_type>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
