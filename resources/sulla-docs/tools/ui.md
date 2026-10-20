# UI Navigation

The agent can open Sulla Desktop's built-in views (Use Cases, vault, routines, etc.) from chat. The tool sends the request to the renderer's `agent-command` handler, the same one keyboard shortcuts and deep links use.

For external URLs and extension web UIs (Twenty CRM, etc.), use [`browser/tab`](browser.md) instead — those aren't built-in modes.

## `ui/open_tab`

```bash
sulla ui/open_tab '{"mode":"marketplace"}'
sulla ui/open_tab '{"mode":"vault"}'
sulla ui/open_tab '{"url":"https://github.com/merchantprotocol"}'   # raw URL → browser tab
```

| Field | Notes |
|-------|-------|
| `mode` | A tab mode (below), or one of the separate windows `settings`, `models`, `audio` |
| `url` | Alternative to `mode` — opens a raw browser tab inside Sulla Desktop on the given URL |

**Tab modes** (`mode` values the tool accepts):
`chat`, `use-cases`, `packages`, `marketplace`, `integrations`, `vault`, `routines`, `history`, `secretary`, `document`, `browser`, `welcome`, `agents`, `projects`, `files`, `decide`.

`use-cases`, `packages` and `marketplace` all open the same view. Use `use-cases` in user-facing text. The Use Cases view is the marketplace.

**Window modes** (not tabs):
- `settings` opens the Preferences window.
- `models` opens Language Model Settings.
- `audio` opens Audio Settings.

Behavior:
- Opens a new tab in the **main agent window** in the requested mode (the renderer's tab manager handles dedup / focus rules per mode).
- If the renderer is still loading at call time, the IPC fires after `did-finish-load`.
- Returns `successBoolean: false` if the main agent window isn't available (Sulla Desktop UI not ready).

## When to use which mode

| Mode | Opens |
|------|-------|
| `use-cases` | Use Cases browser |
| `vault` | Credential vault UI |
| `integrations` | Integration accounts (connect / disconnect) |
| `routines` | Routine / workflow editor + library |
| `history` | Conversation history browser |
| `secretary` | Secretary Mode (live meeting transcription) |
| `chat` | Fresh chat session |
| `document` | Rendered HTML/markdown document viewer |
| `browser` | Standard web browser tab (use `url` for the address) |
| `welcome` | Onboarding / welcome screen |
| `agents` | Agent network / jobs |
| `projects` | Projects view (Postgres project items: projects, epics, tasks) |
| `settings` | Preferences window (window, not a tab) |

## Common requests

### "Open Use Cases" / "Open the marketplace"
```bash
sulla ui/open_tab '{"mode":"use-cases"}'
```

### "Show me my workflow / routines"
```bash
sulla ui/open_tab '{"mode":"routines"}'
```

### "Open my vault" / "I need to manage my passwords"
```bash
sulla ui/open_tab '{"mode":"vault"}'
```

### "Take notes for this meeting"
```bash
sulla ui/open_tab '{"mode":"secretary"}'
```

### "Open Projects" / "Show me projects"
```bash
sulla ui/open_tab '{"mode":"projects"}'
```

### "Open Twenty CRM"
This is an extension web UI, not a built-in mode — use `browser/tab` with the URL from `extensions/list_installed_extensions`:
```bash
sulla browser/tab '{"action":"upsert","url":"http://localhost:30207"}'
```

## What this still doesn't do

- **No deep-linking inside a view yet.** Opening `routines` lands you on the index, not on a specific routine. The tool doesn't expose per-mode targeting, so use browser tools or let the user click into the specific item.

## Reference

- Tool: `pkg/rancher-desktop/agent/tools/ui/open_tab.ts`
- Manifest: `pkg/rancher-desktop/agent/tools/ui/manifests.ts`
- Renderer handler: `pkg/rancher-desktop/pages/AgentRouter.vue` (`onAgentCommand`)
- Window resolver: `getWindow('main-agent')` from `pkg/rancher-desktop/window/index.ts`
