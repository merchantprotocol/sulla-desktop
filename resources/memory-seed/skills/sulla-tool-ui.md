---
slug: sulla-tool-ui
label: Use the Sulla Ui tools
trigger_when: When you need to use Sulla Ui operations.
trigger_actions: [ui, ui tools]
trigger_phrases: [ui, ui]
scope: [tool-ui]
---

**When:** When you need to use Sulla Ui operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# ui tools

Open Sulla Desktop views (marketplace, vault, routines, etc.) from chat so the user can inspect them directly.

## open_tab

Open or focus a built-in Sulla Desktop view (Use Cases, vault, integrations, routines, history, secretary, chat, document, browser, files, agents, decide, preferences, docker). Use this when the user asks to "open" or "show me" a section of the app.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `mode` | string | Optional |
| `section` | string | Optional |
| `url` | string | Optional |

**Example**

```bash
sulla ui/open_tab '{}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
