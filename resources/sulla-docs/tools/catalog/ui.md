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
