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

## AI models page, role lanes (2026-11-14)

### Problem
Preferences > AI models lists 35 providers (33 unconnected) and never says what each kind of work actually uses. Role models are hard-coded IDs (`modelRouter.ts` `DEFAULT_MODELS`); the saved Codex entries (`gpt-5.3-codex`, `gpt-5.1-codex-mini`) are no longer offered by the user's plan, nothing compares saved models with the live lists, and the page never showed which models were Sulla's built-in defaults. A fallback to a retired model failed a job mid-run.

### Scope
1. **Role lanes.** One row per role (Frontier, Standard, Fast, Coding; Local only when a local provider is connected). Each row is the role's ordered fallback list (`classes[role]`) as chips, left to right, for any connected provider. Chips can be reordered, removed, and added ("+ Add provider" offers connected providers not in the role). A "Used by" note names the built-in workers and lists that use the role.
2. **Picker per chip.** Clicking a chip opens that provider's live model list (the same lists integrations already supply) with: two provider-neutral rules, "First model in the list" and "Name contains <text>", and exact pins. New models are badged, never-use models are disabled, retired models are absent. Providers with no list take a typed model ID, shown as "not verified".
3. **Provenance on every chip:** Sulla default (matches the built-in table and was never chosen), Rule (with today's model), You chose.
4. **Staleness:** a chip whose model is missing from its provider's non-empty live list is shown retired (amber, struck through).
5. **Never-use list:** models the user blocks; rules skip them, the picker disables them, and routing skips them.
6. **Refresh models:** re-fetches every connected provider's list bypassing caches, re-resolves rules, and reports since the previous check: models added, models removed, and rule chips that moved.
7. **Staged changes:** picker choices, reorders and removals are held as pending (marked on the chip) until Save; Discard drops them.
8. **Summary chips** at the top: New chats, Heartbeat, Main agents, Background agents, with the model each resolves to now or "no model" in red.
9. **Page slimming:** Defaults, the Agents and Subconscious lists, the routing explanation and request settings move into one collapsed "Provider order and more" section.

### Data changes (backward compatible)
- `ClassModel` gains optional `rule` (`{ kind: 'first' }` or `{ kind: 'contains', text }`) and `chosen` (true once the user picks it). For a rule, `model` holds the last resolved ID, so routing reads it unchanged.
- `EditableRoutingState` gains `blockedModels: ClassModel[]` (default empty).
- New setting `modelCatalogCheck`: last check time, per-provider model IDs, and the last change report.
- New IPC `model-routing:refresh`.
- `DEFAULT_MODELS.codex` updated to models the Codex catalog offers today (new installs only; saved settings change only through the page).

### Out of scope
Testing a typed model ID with a live request, routing changes beyond skipping blocked models, worker definitions (Codex SOL and LUNA pinning), the agent identity bug on wake, fixing the background agents' missing model, Sulla Cloud sync.

### Success criteria
- With today's setup: the Standard and Coding lanes show `gpt-5.3-codex` retired and the Fast lane `gpt-5.1-codex-mini` retired; Claude and Codex default chips say "Sulla default"; the summary shows Opus 5.5 for new chats, heartbeat and main agents, and "no model" for background agents.
- Picking a model or rule marks the chip pending; Save persists it and the chip shows "You chose" or "Rule"; Discard reverts.
- A "Name contains" rule resolves to the first matching live model not on the never-use list; blocking the current match moves it.
- Refresh models updates the check time and reports added and removed models.
- Existing routing tests still pass; new unit tests cover rule resolution, blocked models, staleness and provenance.

## VM disk size and space (2026-11-14)

### Problem
The runtime creates `data.img` once at a fixed 64 GiB (`src/runtime-host/macos/Sources/SullaRuntime/main.swift` `ensureSparseDataDisk`) and nothing can grow it. The Preferences "Disk size" control was removed (#2264) because no code read `experimental.virtualMachine.diskSize`. On 2026-11-14 the disk filled (15 MB free); it was grown by hand to 128 GiB (`truncate` + online `resize2fs`). The full disk also damaged data: Postgres's `pg_class` name index (tables "did not exist"; fixed with `REINDEX SYSTEM`, physical backup in VM `/mnt/data/backups/base-20261114`) and zero-filled files in the `sulla-files` and `sulla-threat-proxy` images and their Python base layer (rebuilt with no cache). This is why the 90% warning matters. 45 GB is conversation workspaces (30.6 GB of that is 38 per-conversation pnpm stores, kept as is by decision).

### Lessons from the 2026-11-14 manual grow and recovery
1. **Grow only while the VM is fully stopped.** The manual grow was safe because the guest was synced and the `sulla-runtime start` process had exited before `truncate`. Changing the file under a running VM is not allowed.
2. **The real disk is the source of truth, not the setting.** The setting said `100GiB` while the disk was 64 GiB, and after the manual grow the disk (128 GiB) is larger than any saved value. Size comes from `stat` of `data.img`; the setting is only a target.
3. **Sparse file: two different numbers.** Apparent size (64/128 GiB) is the cap; real usage is `st_blocks` (about 60 GB). The Mac free-space warning must use target minus real usage, not the apparent size.
4. **Online `resize2fs` works on the mounted ext4 disk** (`/usr/sbin/resize2fs /dev/vda`, about a second). The device size is visible at `/sys/block/vda/size` right after boot, so the guest can compare device size to filesystem size with no host help.
5. **A full disk silently damages data, not just stops writes.** It broke Postgres's catalog name index ("relation does not exist" for tables that existed) and left zero-filled files in Docker image layers, so containers crash-looped. Nothing reported "disk full" to the user; the symptoms showed up as unrelated errors hours later.
6. **Recovery steps that worked, for reference:** `pg_dump` fails on a damaged catalog, so back up with `pg_basebackup`; then `REINDEX SYSTEM` per database, `pg_amcheck --heapallindexed` to verify, and terminate existing connections (they cache the failed lookup). For images: Docker reuses a damaged base layer by digest even with `--pull --no-cache`, so every image sharing it must be removed and the build cache pruned before rebuilding. Package checksums (`md5sums` under `/var/lib/dpkg/info`) find damaged OS files.
7. **The previous control was removed because nothing read it.** The new tests must show the runtime actually uses the value. The comment in `DockerSection.vue` saying the runtime "grows its sparse disk on demand" is wrong and gets corrected.

### Scope
1. **Disk size setting (grow-only, free entry).** Preferences > Docker (VM card) gets a "Disk size" number field in GB next to Memory/CPU. It shows the real current size (from `data.img`, lesson 2) and used/free. It rejects values at or below the real size with a visible error. It warns, but allows, when the growth (target minus real usage, lesson 3) exceeds the Mac's free space. Stored in the existing `experimental.virtualMachine.diskSize` key. The stale `100GiB` default is removed: with no saved value, the field shows the real disk size. Applies on next VM start, and the save bar says a restart is needed.
   - Host (Swift): `start` accepts `--data-disk-size <bytes>`. New disks are created at that size. Before booting the VM, an existing smaller file is grown with `ftruncate` (lesson 1: this only runs before boot, so the VM is never running). It never shrinks, and if the file is already larger it leaves it alone.
   - Guest (Go agent): after mounting ext4, compare `/sys/block/vda/size` with the filesystem size. If the device is larger, run `/usr/sbin/resize2fs` online (lesson 4). It records the outcome (`grown`, `already full size`, `failed: reason`) and never fails boot on it.
   - Backend (TS): passes the target to `NativeRuntime.start`; `requiresRestartReasons` includes disk size. After boot it reads the guest's resize outcome. If the disk grew but the filesystem did not, Preferences shows that as an error instead of a silent success.
   - Correct the wrong `DockerSection.vue` comment (lesson 7).
2. **Manual "Free up space".** In the same card: a button opening an inline list (no modal) of conversation workspaces with size and last-used date, sorted largest first. User ticks workspaces; Sulla removes only rebuildable folders (`node_modules`, `.pnpm-store`) in them, shows space freed. Source, `.git` and uncommitted work are never touched. Nothing automatic.
3. **90% warning.** When the VM data disk passes 90% used (checked on start and periodically), show a desktop notification once per crossing, and a banner on the VM card linking to Disk size and Free up space. The banner says plainly that a full disk can damage the database and services (lesson 5), so it is not treated as a cosmetic warning.

### Out of scope
Shared pnpm store, automatic workspace cleanup, Docker prune, shrinking the disk, non-macOS, and automated after-full-disk repair (the lesson 6 steps stay manual; a "health check after a full disk" feature can be specced separately).

### Success criteria
- With the current 128 GiB disk and no saved value, the field shows 128 GB, not 64 or 100.
- Setting 160 GB, restarting: `/mnt/data` reports ~157G size, Postgres passes `pg_amcheck`, all services healthy, and the setting survives another restart. Setting 100 GB or 128 GB is rejected.
- A disk already larger than the setting is never shrunk (host test with a temp file).
- Unit tests: size parsing/grow-only validation against the real file size; host grow decision (smaller grows, equal or larger untouched); guest resize decision from device versus filesystem size; the backend passes the saved value to `start` (proves it is read, lesson 7); cleanup path filter refuses anything outside `node_modules`/`.pnpm-store` under a conversation workspace.
- A forced resize failure shows an error in Preferences, not success.
- Free up space on one test workspace frees its caches and leaves source/.git byte-identical.
- Warning shown when usage is >= 90% (simulated threshold in test), not shown below.

## Shelve and resume a thread (2026-11-14)

### Problem
Long-running threads (the RippleCore "main thread") accumulate hours of stale context. There is no clean way to put one down and pick the work up later: closing the tab leaves its heartbeat and agents running in the background, History only reopens the full old thread, and the resume notes Sulla wrote before today's restart were ad hoc, with no standard format, location or way back in.

### Scope
1. **`/shelve [name]`** in any chat. Sulla:
   - Writes a **handoff note** to Sulla Files at `Shelf/<slug>.md` (the slug comes from the name, or the tab title if none is given). Sulla writes the note body; this is a judgment task. Format, in order: goal; decisions made (with who decided); state (merged, open, failing, with PR numbers and commit SHAs); what was running when shelved and what was done to it; open questions for the user; next 3 steps; key files and links. Frontmatter holds `threadId`, `tabTitle`, `shelvedAt`, `agentId` (persona), and `status: shelved`.
   - **Stops background activity** (deterministic code, not the model): turns off the thread's heartbeat, and asks every live agent in the thread to save its work and stop (the same pause-and-report message Sulla used before the restart, then Stop). Agents that do not report within 2 minutes are stopped anyway, and the note lists them as "stopped without a final report".
   - Before doing either, shows a **confirmation card** listing exactly what will stop (agents, heartbeat, any tracked Mac scripts once those exist). Nothing stops until the user confirms. A merge or deploy step in progress blocks the shelve with "finish or cancel <step> first".
   - Marks the thread **Shelved** in History (badge) and closes the tab.
2. **`/resume`** opens a picker in the composer popover listing shelved notes (newest first: name, shelved date, one-line goal). `/resume <name>` skips the picker. Choosing one:
   - **Default: a fresh thread.** It opens a new chat tab, with the same persona, whose first turn is "Read `Shelf/<slug>.md` and continue from there." Before acting, Sulla re-checks anything the note says is in flight (PR states, CI, merges since the shelve date) and reports what changed.
   - **Option: reopen the original thread** (a "Reopen original" action in the picker row) for when the old context is still wanted. It reloads the History thread as today. The heartbeat stays off until the user turns it back on.
   - The note's frontmatter changes to `status: resumed`, with `resumedAt` and `resumedThreadId`. It stays in Files as a record and drops out of the default picker list ("Show resumed" reveals it).
3. **Activity line:** a shelving thread shows "Shelving: waiting on 2 agents to report", so the status line explains the pause.
4. **Delete a shelved thread.** Each picker row has a **Delete** action, and `/shelve delete <name>` does the same. An inline confirmation (not a modal) names what goes:
   - **Default: the note only.** `Shelf/<slug>.md` moves to the Files trash, so it can be restored from Files until the trash is emptied, and drops off the picker.
   - **Checkbox, off by default: "Also delete the original conversation".** This removes the thread from History through the existing `conversation-history:delete`. The confirmation says plainly that this cannot be undone.
   - Deleting a shelved thread never touches its PRs, branches or anything outside Sulla. If any of its agents are somehow still live, the delete is refused with "stop <agent> first" instead of stopping them silently.
   - Resumed notes (hidden by default) can be deleted the same way from "Show resumed".

### As built (2026-11-14), where it differs from the above
- Notes live at `Projects/Shelf/<slug>.md` (agents see `/mnt/sulla-files/Projects/Shelf/`). Files only lets agents write under `Projects`, `Memory` and `Use Cases`, and keeping them out of `Memory` stops them being pulled into memory recall.
- Sulla writes only the note body, as a chat reply between `<handoff>` tags. The app adds the frontmatter and saves the file through the main process (`main/threadShelf.ts`), so the location and format are always exact. The note's request is visible in the thread.
- "Shelved" in History is History's existing **Archived** state, not a new badge.
- The merge/deploy guard is "Sulla is mid-reply: wait or stop it". Agents doing merges get the pause message first ("start no new merges, deploys or migrations") and are only stopped after 2 minutes.
- Reopen original restores the conversation in its ORIGINAL tab id through `restoreChatFromHistory`, the same path History uses. A fresh tab id opens a blank chat, because the tab id links the chat pointer and the persona's backend thread.
- Shelve archives, and delete removes, every History row for the chat: one per tab that showed it plus the backend-thread row.
- Notes whose status an agent rewrote ("done") count as resumed, and the resume prompt tells Sulla not to edit the frontmatter.
- Removing the conversation from History is History's soft delete (recoverable), so the confirmation does not claim it is permanent.
- Code: `pages/chat/messages/shelfNote.ts` (parsing, slugs, frontmatter, prompts), `shelfStop.ts` (stop sequence), `components/composer/ShelfPanel.vue`, `main/threadShelf.ts` (Files store and IPC), the composer wiring, and `ChatPage.startShelfResume` (fresh-tab handoff). 23 tests.

### Out of scope
Automatic shelving of idle threads, sharing shelf notes across devices beyond what Files sync already does, shelving sub-agent tabs on their own (shelve the parent), and tracked Mac scripts (separate item; once they exist, `/shelve` stops them too).

### Decisions taken (change before build if wrong)
- Notes live in Files (`Shelf/`), not the database, so they are readable, editable by hand and survive reinstalls. Listing reads that folder.
- Shelving stops agents by default. Leaving them running defeats the purpose and was the source of today's "thread keeps working after I closed it" confusion.
- Resume defaults to a fresh thread; reopening the original thread is the secondary option.

### Success criteria
- `/shelve rc-billing` on a thread with a heartbeat and 2 live agents: the card lists all three; after Confirm, both agents report then stop, the heartbeat is off, `Shelf/rc-billing.md` exists with all sections and frontmatter, the tab closes, and History shows the badge.
- A shelve with a merge in progress is refused with the reason, and nothing is stopped.
- `/resume` lists the note. Choosing it opens a new tab whose first reply summarises the note and lists what changed since the shelve date. The note becomes `resumed`.
- Delete with the default confirmation moves the note to the Files trash, it leaves the picker, and History still has the conversation. With the checkbox on, the conversation is gone from History too. A delete is refused while any of its agents are live.
- Unit tests: slug generation and collisions (`-2` suffix); frontmatter round-trip; delete scope (note only vs note plus conversation) and the live-agent refusal; the stop sequence (report, wait, stop, timeout path) against a fake agent controller; picker ordering and the resumed filter.

## Tab hover preview stuck on screen (2026-11-14)

### Problem
The tab hover preview (title plus "chat · ready") stayed floating over the History page, naming "Codex LUNA Worker", a tab no longer in the strip. The preview only hid on `mouseleave` of its tab. Sulla closes idle agent tabs by itself, so a tab removed under the pointer never fired `mouseleave`. The preview's 500 ms timer could also fire after the tab had already gone. A kept-alive header hidden by navigation kept its preview too.

### Fix (implemented, ships with the next restart): `pages/agent/AgentHeader.vue`
- The preview remembers its `tabId`. A watch on the strip's tab ids hides it when that tab disappears.
- The delayed show checks the tab still exists before showing.
- The preview is hidden on route change and on `onDeactivated` (kept-alive header hidden).

### Verification
After the restart: hover an agent tab, close it (or let Sulla idle-close it) without moving the pointer, and confirm no preview remains. Switch tabs while a preview is showing and confirm it clears. No unit test, because `AgentHeader` is not mountable in isolation; this is covered by the in-app check above.

## Testing & QA (local dev build)
- Unit tests: `yarn vitest run <path>` from the repo root.
- Build: `NODE_OPTIONS="--max-old-space-size=12288" yarn build`; run with `yarn start` (quit the installed app first).
- Visual QA: the dev window cannot be screenshotted via macOS window capture; use Chrome DevTools Protocol on the Electron renderer (`--remote-debugging-port`) for screenshots and DOM checks.
