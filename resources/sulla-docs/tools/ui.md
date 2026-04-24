# UI Navigation

The agent can open Sulla Desktop's built-in views (marketplace, vault, routines, etc.) from chat. This bridges the renderer's existing `agent-command` IPC handler — which until now was only fired by keyboard shortcuts and deep-link callbacks.

For external URLs and extension web UIs (Twenty CRM, etc.), use [`browser/tab`](browser.md) instead — those aren't built-in modes.

## `ui/open_tab`

```bash
sulla ui/open_tab '{"mode":"marketplace"}'
sulla ui/open_tab '{"mode":"vault"}'
sulla ui/open_tab '{"url":"https://github.com/merchantprotocol"}'   # raw URL → browser tab
```

| Field | Notes |
|-------|-------|
| `mode` | One of: `marketplace`, `vault`, `integrations`, `routines`, `history`, `secretary`, `chat`, `document`, `browser`, `welcome` |
| `url` | Alternative to `mode` — opens a raw browser tab inside Sulla Desktop on the given URL |

Behavior:
- Opens a new tab in the **main agent window** in the requested mode (the renderer's tab manager handles dedup / focus rules per mode).
- Focuses the window so the user sees the change.
- If the renderer is still loading at call time, the IPC fires after `did-finish-load`.
- Returns `success: false` if the main agent window isn't available (Sulla Desktop UI not ready).

## When to use which mode

| Mode | Opens |
|------|-------|
| `marketplace` | Recipe / extension marketplace browser |
| `vault` | Credential vault UI |
| `integrations` | Integration accounts (connect / disconnect) |
| `routines` | Routine / workflow editor + library |
| `history` | Conversation history browser |
| `secretary` | Secretary Mode (live meeting transcription) |
| `chat` | Fresh chat session |
| `document` | Rendered HTML/markdown document viewer |
| `browser` | Standard web browser tab (use `url` for the address) |
| `welcome` | Onboarding / welcome screen |

## Common requests

### "Open the marketplace"
```bash
sulla ui/open_tab '{"mode":"marketplace"}'
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

### "Open Twenty CRM"
This is an extension web UI, not a built-in mode — use `browser/tab` with the URL from `extensions/list_installed_extensions`:
```bash
sulla browser/tab '{"action":"upsert","url":"http://localhost:30207"}'
```

## What this still doesn't do

- **No deep-linking inside a view yet.** Opening `routines` lands you on the index, not on a specific routine. The deep-link IPC supports a `details` payload (e.g. `marketplace:open-detail`), but the agent tool doesn't expose per-mode targeting yet — call browser tools or rely on the user to click into the specific item.
- **Settings is a separate window**, not a tab mode. No agent tool to open it today.
- **Computer Use Settings UI** has no agent path — direct user to it.

## Reference

- Tool: `pkg/rancher-desktop/agent/tools/ui/open_tab.ts`
- Manifest: `pkg/rancher-desktop/agent/tools/ui/manifests.ts`
- Renderer handler: `pkg/rancher-desktop/pages/AgentRouter.vue` (`onAgentCommand`, lines ~292-340)
- Window resolver: `getWindow('main-agent')` from `pkg/rancher-desktop/window/index.ts`
