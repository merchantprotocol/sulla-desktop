# Sulla Desktop (local fork) - Project Specsheet

## Typography controls and focus cue (2026-11-13)

### Scope
Preferences > Appearance gets a **Typography** card with per-section controls. Each section has curated presets only:

| Section | Applies to | Controls |
|---|---|---|
| Menus | Chat, file and filesystem context menus | font, size, color |
| Top tabs | Tab strip in the app header | font, size, color |
| Sidebar | Files sidebar and Preferences sidebar | font, size, color |
| Text output | Chat message bodies (Sulla replies and your messages) | font, size, line spacing, color (Sulla replies only; your bubble keeps on-accent text for contrast) |
| Output formatting | Headings, code and links inside chat replies | heading scale, heading color, code font, code size, link color |

- Fonts: Default (theme), System Sans, Serif (New York), Mono (SF Mono), Rounded (SF Pro Rounded). All ship with macOS; no downloads.
- Colors are theme token names (Primary, Secondary, Muted, Accent, Link), never raw hex, so every choice stays readable in light and dark themes.
- Every control has a "Default" value that leaves the current look untouched. Per-section Reset and Reset all.
- Persistence: `SullaSettingsModel` key `typography` (json), mirrored to localStorage for live cross-window updates (same pattern as theme).
- Mechanism: values become `--type-*` CSS variables on `<html>`; component styles read them with the previous value as the `var()` fallback.

### Focus cue (all text fields)
On focus, placeholders fade to ~35% opacity and the caret uses the full text color. Fields that turn their outline off get a visible focus indication through their container.

### Out of scope
Rich text inside messages, arbitrary installed fonts, free color picker, per-theme typography, Sulla Cloud sync of typography.

### Success criteria
- Each control changes only its section, live, and persists across restart.
- Defaults produce no visual change.
- Unit tests: defaults, sanitizing/clamping of stored values, CSS variable output.
- Visual check against the dev build in light and dark themes.

## Heartbeat visibility (2026-11-13)
- The heart's on state used `--accent-hover`, an 8%-alpha hover tint in Noir, and the running state dimmed it further; on now uses solid `--accent` with a tinted pill and stays lit (not beating) while a run is active.
- The switch's off state now has a visible track edge and a light thumb.

## Structured long replies (2026-11-13)
- Prompt section `reply_format` (agent/prompts/sections/replyFormat.ts) asks for `##` Summary, Done, Issues found (bold Blocker/Problem/Note), Decisions needed, Next steps. Short answers stay prose.
- `structureReply` (pages/chat/messages/replyStructure.ts) groups completed replies into section cards by heading and tags issue bullets by severity. Unknown headings get a neutral card; replies without headings are unchanged. A test keeps the prompt headings and the renderer in sync.
- Out of scope: restructuring old messages' wording, the streaming (in-progress) view.

## Vault-caused failures (2026-11-13)
- The provider bridge records vault refusals (`vault-broker/vaultHealth.ts`): 423/`vault_locked` = locked; `vault_unreachable_*`, `vault_starting`, `vault_unavailable` = unreachable.
- CLI recovery (`runWithCliFaultRecovery`) checks that record after a failed attempt: it waits up to 15 minutes for the vault (once per run, no attempt spent), then reports `VaultLocked` or `VaultUnreachable` instead of "stopped after its recovery attempts".
- Vault failures classify as infrastructure: they never mark the model provider unhealthy and never ask to reconnect a model.
- Chat banner: a locked, set-up vault shows "Your Password Vault is locked" + Unlock vault (opens the vault tab) instead of "Connect an AI model".

## Answered prompts and chat scrolling (2026-11-13)
- Question cards lock and fade the moment Submit is pressed (before the backend confirms); a backend rejection reopens them.
- The transcript stays pinned to the bottom while a reply streams (ResizeObserver on content) whenever the reader is within 80px of the bottom; scrolling up unpins.

## Answered cards reopening after restart (2026-11-13)
- Cause 1: cards are rebuilt from history as "pending"; their outcome lives in the decisions store, which the chat only heard about through live `decisions:changed` events. PersonaAdapter now loads `decisions:list` on start, remembers each outcome, and settles cards on load, on restore and on re-sync.
- Cause 2: backend sync re-appended cards already restored from the local save (same id), and by-id updates only reached the first copy. Restored ids are now updated in place, duplicates are removed once (`ChatController.removeDuplicateMessages`), and a re-mapped card never downgrades a resolved status.
- Verified in the running app: 18 cards (11 open) became 8 cards, all Answered/Closed, faded, no Submit buttons.

## Top tabs, option A (2026-11-13)
- Pinned tabs keep a short title (max 150px), show a pin glyph and an accent underline; a divider separates them from normal tabs.
- Normal tabs size to their title between 160px and 260px (was 112-176px); the close button stays hover-only; the strip scrolls with its arrows when full.

## Question card expiry (2026-11-13)
- Expiry stays 5 minutes (user choice). Cards show "Waiting for your answer · expires in m:ss" (amber under a minute), using `expiresAt` from the decisions store.
- An expired, unanswered card says so; if the user had picks, "Send my answers as a message" posts them to the chat so the work isn't lost.

## Testing & QA (local dev build)
- Unit tests: `yarn vitest run <path>` from the repo root.
- Build: `NODE_OPTIONS="--max-old-space-size=12288" yarn build`; run with `yarn start` (quit the installed app first).
- Visual QA: the dev window cannot be screenshotted via macOS window capture; use Chrome DevTools Protocol on the Electron renderer (`--remote-debugging-port`) for screenshots and DOM checks.
