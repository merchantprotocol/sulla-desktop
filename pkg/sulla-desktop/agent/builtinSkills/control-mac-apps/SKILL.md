---
name: Control Mac apps
description: Reliably see and operate Mac apps through their accessibility trees.
---

# Control Mac apps

1. Call `desktop/permissions` first. If Accessibility or Screen Recording is missing, tell the human; only use `guide: true` when they want System Settings opened.
2. Call `desktop/snapshot` for the app. Use `interactive_only: true` by default, and use `skeleton`, `compact`, then `root` for dense apps.
3. Call `desktop/act` with a qualified ref from that snapshot.
4. Snapshot again to verify the result. Refs belong to their snapshot; on `STALE_REF`, snapshot again and choose a new ref.

Prefer `desktop/*` over AppleScript UI scripting. Desktop actions are headless by default. Only set `headed: true` when physical pointer or keyboard input is necessary and the human is idle.
