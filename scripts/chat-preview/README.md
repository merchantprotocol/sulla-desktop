# Chat renderer preview

This is a browser-only harness for the real `ChatPage`/`Transcript` renderer. It seeds a synthetic Lantern Bay conversation into local storage; it never connects to Electron or a real account.

## Start

From the repository root (shared dependencies must already be linked):

```sh
CHAT_PREVIEW_PORT=8888 node scripts/chat-preview/serve.cjs
```

Open `http://127.0.0.1:8888/chat-preview.html?level=info&theme=default-light` in a browser. `level=info` is Standard and `level=debug` is Detailed; `theme` is any app theme id. The header reporting control remains live and follows the real `ChatPage` ref. If port 8888 is occupied, set `CHAT_PREVIEW_PORT` to a free port and use that URL. From the Sulla hidden browser tab, use the VM-reachable URL printed by Vite (usually `http://127.0.0.1:<port>/chat-preview.html?...`).

## Measuring Standard items

The harness does not add measurement attributes to app components. Capture these existing selectors in both levels:

- `.chat-dialogue > .report-entry` — transcript entry roots
- `.report-entry .report-label` — labels when present
- `.scroll-pill` — scroll affordance
- `.chat-header`, `.ch-reporting` — header and reporting control
- `.chat-dialogue .chat-turn.user`, `.chat-dialogue .chat-turn.sulla` — user/reply roots
- `.chat-dialogue .supporting-reports`, `.chat-dialogue .inline-file-card` — evidence/file cards

Compare `getBoundingClientRect()` and `getComputedStyle()` for the same Standard selectors after loading `level=info` and `level=debug`. Detailed may add trace siblings, but it must not alter these Standard roots.
