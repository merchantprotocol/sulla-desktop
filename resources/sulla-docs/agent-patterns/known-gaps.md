# Known Gaps — User Requests Without a Tool

When a user asks for one of these, **don't pretend it works**. Either say "no tool for that yet" and offer the closest workaround, or escalate to Jonathon. This doc keeps you honest.

Severity: 🔴 high (likely to come up often) · 🟡 medium · 🟢 occasional

Last full verification against the codebase: 2026-04-23.
Partial re-verification 2026-08-22 (heartbeat cycle): the delegation stack is converging on one primitive — `spawn_agent` (async background sub-agents with parent-graph wake), `check_agent_jobs`, and `stop_agent_job`. `start_agent_conversation` is now only an async compatibility shim over `spawn_agent`; `send_agent_message` returns migration guidance because persistent multi-turn continuation was intentionally retired (see [`tools/agents.md`](../tools/agents.md)). "Delegate work in the background" is no longer a gap; a future iterative `continue_agent_job` lifecycle remains separate scope.

A second 2026-08-14 pass swept the live tool registry (`meta/browse_tools`) row-by-row and corrected these against what's actually registered: **Secretary Mode** start/stop/status now have `secretary/*` tools (was "UI-only"); **Capture** gained a recorder + camera/screen scene lifecycle (`recorder_start/stop/status`, `screen_set`, `camera_*`) so multi-source recording is agent-driven (was 🔴 "not built"); **Workflows** gained `workflow/display_workflow` (CLI render) and `routine_report`/schedule tools; and the **GitHub** rows had wrong tool names — the live names are `github/merge_pr`, `github/check_runs`, `github/trigger_workflow_run` (no redundant `github_` prefix). Rows not stamped *(verified 2026-08-14)* still carry their 2026-04-23 status — treat those as needing re-verification, not gospel.

A third 2026-08-14 pass swept the remaining *absence*-claim rows against the tool source (`pkg/rancher-desktop/agent/tools/*/manifests.ts`) — the harder-to-falsify "no tool for that" entries. Confirmed **still absent**: Docker `stats`/`inspect`/`system_prune` (only `docker_exec`/`docker_logs`/`docker_ps` registered); Calendar GCal-sync and native RRULE recurrence (the 7 `calendar_*` tools are single-event only); Mobile QR-pairing and desktop→phone file transfer. **New capability found + documented:** `mobile/list_devices` (shipped, was undocumented) answers "is my phone paired/reachable right now" — every registered device with online/offline status. `ui/open_tab` modes confirmed: `marketplace`, `integrations`, `vault`, `routines`, `history`, `secretary`, plus `settings` (special-cased Preferences window) — no `capture-studio` mode. Every row touched this pass carries a *(… verified 2026-08-14)* stamp.

---

## UI Navigation (cross-cutting)

**Resolved.** [`sulla ui/open_tab`](../tools/ui.md) bridges the renderer's `agent-command` IPC. All built-in views + the Settings window are openable from chat.

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Open the marketplace | `sulla ui/open_tab '{"mode":"marketplace"}'` | |
| ✅ Open my vault / integrations / routines / history / secretary | `sulla ui/open_tab '{"mode":"<mode>"}'` | |
| ✅ Open Settings | `sulla ui/open_tab '{"mode":"settings"}'` | Handled as the separate Preferences window |
| ✅ Open Twenty CRM | `sulla browser/tab '{"url":"..."}'` | extension web UIs use browser/tab |
| 🟡 Show me the specific workflow I just created | `ui/open_tab '{"mode":"routines"}'` opens the index | per-item deep-link not exposed yet |
| 🟡 Open Computer Use Settings pane deep-link | `ui/open_tab '{"mode":"settings"}'` opens Settings | can't pre-select the Computer Use pane |

---

## Workflows

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Stop / cancel a running workflow | `sulla meta/stop_workflow '{"executionId":"..."}'` | Cooperative (Redis flag honored at next frontier tick) |
| ✅ Pause this workflow, I'll resume later | `sulla meta/pause_workflow` + `sulla meta/resume_workflow` | Cooperative; in-flight work not cancelled |
| ✅ Test a workflow without running it for real | `sulla meta/dry_run_workflow '{"slug":"..."}'` | Static walk; reports execution order, orphans, ambiguous router branches |
| 🔴 Show what my workflow is doing right now | — | Still only post-hoc checkpoint trail; no live per-node state stream |
| 🟡 Show me the workflow visually | `sulla workflow/display_workflow '{"slug":"..."}'` renders a CLI text view (nodes + edges); `ui/open_tab '{"mode":"routines"}'` opens the canvas | *(verified 2026-08-14)* No inline graphic, but the structure is now inspectable from chat |
| 🟢 List my workflows / what's scheduled | `sulla workflow/routine_report '{}'`, `workflow/refresh_schedules`, `workflow/catch_up_schedules`, `workflow/set_workflow_status` | *(verified 2026-08-14)* Schedule/status tooling now exists; a flat "list all workflows" CLI is still not a dedicated tool |

---

## Functions

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Show me past runs of function X | `sulla function/function_runs '{"slug":"..."}'` | New `function_runs` table populated on every invocation |
| ✅ Why did my function fail yesterday? | `sulla function/function_runs '{"slug":"...","only_failures":true,"verbose":true}'` | error_stage + error captured per run |
| ✅ Scaffold a function from a template | `sulla marketplace/scaffold '{"kind":"function","slug":"..."}'` | |
| 🟡 Schedule this function to run daily | — | Wrap in a workflow with a `schedule` trigger |
| 🟡 Run in the background / async | — | `function_run` blocks synchronously |
| 🟡 Stream the output | — | No streaming; full trace returned at completion |

---

## Vault

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Delete this credential | `sulla vault/vault_delete_credential '{"account_type":"...","property":"...","confirm":true}'` | Refuses without `confirm:true` |
| 🔴 Connect my Slack/etc via OAuth | — | Agent can't run OAuth; direct user to Settings |
| 🟡 Rotate this API key | — | No dedicated rotation tool |
| 🟡 Import from 1Password / LastPass | — | No import |
| 🟢 Export all my credentials for backup | — | No export (defensible) |

---

## Marketplace / Extensions

The `marketplace/*` (10 tools, generic across 6 kinds: skill / function / workflow / agent / recipe / integration) and `extensions/{start,stop,get_status}_extension` shipped.

| Request | Severity | Status |
|---------|----------|--------|
| ✅ Update Twenty CRM to the latest | `sulla extensions/install_extension` with new tag, or `marketplace/update` for non-recipe artifacts | shipped |
| ✅ Start / stop a recipe | `sulla extensions/start_extension` / `stop_extension '{"confirm":true}'` | shipped |
| ✅ Build me a new recipe / skill / function / workflow / agent | `sulla marketplace/scaffold '{"kind":"...","slug":"..."}'` | shipped |
| ✅ Validate before publishing | `sulla marketplace/validate '{"kind":"...","slug":"..."}'` | shipped |
| ✅ Publish to marketplace | `sulla marketplace/publish` (cloud worker not yet deployed; tool returns clear error) | shipped (client side) |
| 🟡 Restart in one call | No `restart` tool. Compose `stop_extension` + `start_extension`. |
| 🟢 Notify me when new artifacts appear | No diff/watch |
| 🟢 Install from a private registry | Unclear if supported |
| 🔴 Cloud marketplace worker | `sulla-cloud/workers/marketplace` not yet deployed — writes return "not reachable" |

---

## Calendar

| Request | Severity | Status |
|---------|----------|--------|
| Sync with Google Calendar / iCal | 🔴 | No GCal integration. *(still absent, verified 2026-08-14)* |
| Make this meeting recurring (every Tuesday) | 🔴 | No native RRULE. *(still absent, verified 2026-08-14 — the 7 `calendar_*` tools create/get/list/list_upcoming/update/cancel/delete; none are recurrence-aware)* Workaround: create N events |
| Email the attendees | 🔴 | `people` is metadata only; nothing sent |
| Add a Zoom / Meet link | 🟡 | No conferencing integration |
| Snooze this reminder | 🟡 | No snooze; agent must update event |
| Attach a file to the event | 🟢 | No attachments |

---

## Notifications

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Notify my phone too | `sulla notify/notify_user '{"title":"...","message":"...","targets":["desktop","mobile"]}'` | Mobile leg calls `POST /push/{user_id}` on sulla-workers (route needs to be deployed on the backend) |
| ✅ Show me missed notifications | `sulla notify/history '{"only_failures":true}'` | New `notifications` table records every call with delivery status |
| 🔴 Reply directly from notification | — | No action buttons |
| 🟡 Send me a text / email when X | — | No SMS/email channel |
| 🟢 Snooze | — | No primitive |

---

## Heartbeat

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Only run between 9am–5pm weekdays | Set `heartbeatWindow` setting: `{days:[1,2,3,4,5],startHour:9,endHour:17,tz:"America/Los_Angeles"}` | HeartbeatService respects days + hour range; wraps midnight if start > end |
| 🟡 Disable just one heartbeat behavior | — | Still all-or-nothing; no per-behavior toggle |
| 🟢 Standing goal that survives restart | Partial | Observational memory, plus the Outcome Ledger convention (`~/sulla/ledger/LEDGER.md` + `goals/`) the heartbeat reads each cycle. Still a file/memory convention, not a first-class per-goal scheduler primitive. |

---

## Docker / Lima / Kubernetes

| Request | Severity | Status |
|---------|----------|--------|
| Open an interactive shell into a container | 🔴 | `docker_exec` runs commands; no PTY |
| Restart Postgres / Redis / a runtime safely | 🔴 | Owned by ServiceLifecycleManager; only path is restart Desktop |
| Show CPU / memory / disk usage | 🟡 | No `docker_stats`. *(still absent, verified 2026-08-14 — only `docker_exec`/`docker_logs`/`docker_ps` are registered)* |
| Inspect a container's config / env | 🟡 | No `docker_inspect`. *(still absent, verified 2026-08-14)* |
| Clean up unused images | 🟡 | No `docker_system_prune`. *(still absent, verified 2026-08-14)* |
| Get pod logs (`kubectl logs`) | 🟡 | No dedicated tool — workaround via `rdctl_shell 'kubectl logs ...'` |
| Stream pod logs | 🟢 | No streaming |
| Manage compose stacks directly | 🟢 | Only via extensions API |

---

## Browser

| Request | Severity | Status |
|---------|----------|--------|
| Download this file from the page | 🟡 | Unclear if cleanly supported |
| Save page as PDF | 🟡 | No print-to-PDF helper |
| Record my browsing session | 🟢 | No |

## Computer Use (full pixel-level OS control)

| Request | Severity | Status |
|---------|----------|--------|
| Take a screenshot of my whole desktop | 🔴 | Not shipped. Phase 1 (grid overlay + screencapture) designed only |
| Click anywhere on my screen (outside the browser) | 🔴 | Not shipped. Phase 2 (CGEvent native input) designed only |
| Type into a non-browser app | 🔴 | Same — designed not shipped |
| Drag and drop on the desktop | 🟡 | Same |
| Multi-display interaction | 🟡 | Phase 4 |
| Computer-use confirmation UI / kill switch | 🟡 | Phase 4 |

**What's available today:** AppleScript-mediated app control (`tools/applescript.md`) for any allowlisted app, plus browser-internal pixel control (`browser/click_at`, `browser/type_at`, `browser/screenshot`). Anything outside those domains is the planned but not-yet-built computer use.

## AppleScript

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Audit log of past AppleScript executions | `sulla applescript/audit_log '{"only_failures":true}'` | Every applescript_execute now writes a row to `applescript_audit` (target_app, script, success, duration, error) |
| 🔴 Run shell from inside AppleScript (`do shell script`) | — | **Blocked for security** — won't change |
| 🔴 Use `with administrator privileges` | — | **Blocked for security** — won't change |
| 🟡 AppleScript for an app not in the allowlist | — | Add the app to `pkg/rancher-desktop/main/computerUseSettings/appRegistry.ts` first |
| 🟡 Open Computer Use Settings UI from chat | — | Settings window opens via `ui/open_tab '{"mode":"settings"}'` but not deep-linked to the Computer Use pane |

---

## Capture Studio

The `capture/*` category (19 tools as of 2026-08-14) shipped 2026-04-23 and grew a recorder + camera/screen scene lifecycle since. Multi-source recording is now agent-controllable (see rows below).

| Request | Severity | Status |
|---------|----------|--------|
| ✅ Take a screenshot | `sulla capture/screenshot '{}'` | shipped |
| ✅ List screens / windows | `sulla capture/list_screens '{}'` | shipped |
| ✅ Start / stop microphone capture | `sulla capture/mic_start` / `mic_stop` (ref-counted) | shipped |
| ✅ Start / stop desktop-audio loopback | `sulla capture/speaker_start` / `speaker_stop` | shipped |
| ✅ Drive the teleprompter | `sulla capture/teleprompter_*` (open/close/script/style/status) | shipped |
| ✅ Check audio capture state | `sulla capture/audio_state` | shipped |
| ✅ Start / stop a multi-source recording session | `sulla capture/recorder_start` / `recorder_stop` / `recorder_status` (auto-acquires configured sources) | *(verified 2026-08-14 — registered)* Renderer command bus now exists; drive the session from chat |
| 🔴 Open the Capture Studio window | UI navigation gap — `ui/open_tab` doesn't have a `capture-studio` mode yet | *(not re-verified 2026-08-14)* |
| ✅ Add screen + camera to current scene mid-session | `sulla capture/screen_set '{"sourceId":"..."}'` + `camera_list` / `camera_set` / `camera_release` | *(verified 2026-08-14 — registered)* Enumerate then set the active screen/camera source |
| 🟡 Get the path of my last recording session | No dedicated tool — `meta/exec` + `ls ~/sulla/captures/` works |
| 🟡 Transcribe a saved recording | Whisper is wired for live, not retroactive batch — write a custom function |

⚠️ **BlackHole broken on macOS 15** — `speaker_start` won't actually capture system audio until alternative loopback ships. Mic and screenshots still work fine.

---

## Secretary Mode

| Request | Severity | Status |
|---------|----------|--------|
| ✅ Start secretary mode | — | `sulla secretary/start '{}'` *(verified 2026-08-14 — registered)*. No longer UI-only; `Cmd+Shift+S`/tray still work too |
| ✅ Stop secretary mode | — | `sulla secretary/stop '{}'`; `sulla secretary/status '{}'` reports whether it's running *(verified 2026-08-14)* |
| Get my last meeting notes | 🟡 | No dedicated retrieval tool — meeting transcripts are in chat history but no clean query |
| "Hey Sulla, what was the action item from earlier?" | 🟢 | Wake word works but the agent has no structured query into the analysis output |

Secretary Mode is **shipped and works**, and as of 2026-08-14 its start/stop/status lifecycle is **agent-controllable** via the `secretary/*` tools. Retrieval of past meeting notes is still the open gap.

---

## Sulla Mobile (paired iOS app)

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Show me my last call from mobile | `sulla mobile/list_calls` + `sulla mobile/get_call '{"id":"..."}'` | Hits sulla-workers with the mobile JWT from vault `sulla-cloud/api_token` |
| ✅ Show me my leads | `sulla mobile/list_leads` | Inbox contents with urgency/qualified filters |
| ✅ Show me my messages | `sulla mobile/list_messages` | SMS + voicemail transcripts |
| ✅ Is my phone paired / reachable right now? | `sulla mobile/list_devices '{}'` (filters: `online_only`, `device_type:"mobile"`) | *(shipped, verified 2026-08-14 — was undocumented)* Lists every registered desktop+mobile device with online/offline status (online = hit the worker within the last 2 min). Doesn't create a pairing, but answers "can I route to the phone right now" — check this before routing to `targets:["mobile"]`. |
| ✅ Send a notification to my phone | `sulla notify/notify_user '{"targets":["mobile"]}'` | sulla-workers `/push/{user_id}` leg needed |
| 🔴 Pair my phone via QR code | — | Phase 2 of pairing; manual (same account sign-in) today. *(still absent, verified 2026-08-14 — `mobile/list_devices` shows pairing STATUS but can't initiate a QR pair)* |
| 🔴 Send a file from desktop to phone | — | No transfer mechanism. *(still absent, verified 2026-08-14)* |
| 🔴 Sync calendar to mobile | — | Mobile has its own server-side data; no shared calendar today |
| 🟡 Take over a live call from desktop | — | Only the phone can |

---

## Sulla Cloud

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Sign me up for Cloud | SullaCloudCard UI (Marketplace tab) | Point user with `sulla ui/open_tab '{"mode":"marketplace"}'` |
| 🔴 Show me my Cloud usage / bill | — | Cloud doesn't expose a usage API yet |
| 🟡 Pause / cancel my Cloud subscription | — | Tier changes happen in the card UI |
| 🟡 Migrate my Desktop setup to Cloud | — | No migration tool |

---

## GitHub

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Merge this PR | `sulla github/merge_pr '{"owner":"...","repo":"...","pull_number":N,"confirm":true}'` | merge / squash / rebase methods. *(name corrected 2026-08-14 — it's `github/merge_pr`, NOT `github/github_merge_pr`)* |
| ✅ Show CI status for this branch | `sulla github/check_runs '{"owner":"...","repo":"...","ref":"..."}'` | Lists runs with status + conclusion + timing. *(name corrected 2026-08-14 — `github/check_runs`)* |
| ✅ Trigger a GitHub Action | `sulla github/trigger_workflow_run '{"owner":"...","repo":"...","workflow_id":"ci.yml","inputs":{...}}'` | Requires workflow_dispatch trigger in the target workflow. *(name corrected 2026-08-14 — `github/trigger_workflow_run`)* |
| 🟡 AI-review this PR | Partial | No one-shot AI-review tool: pull the diff with `github/get_pr_files`, generate the review, then post it with `github/add_pr_review` (`list_pr_reviews` reads existing reviews). *(verified 2026-08-14)* |

---

## General / Cross-cutting

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Update Sulla Desktop | electron-updater + Longhorn provider | Runs automatically; see [`environment/updates.md`](../environment/updates.md). No agent tool yet — user controls install via the Updates UI. |
| 🔴 Backup my whole Sulla setup | — | No backup tool. `~/sulla/` + `~/.sulla/` + Postgres dump = manual |
| 🟡 Why is Sulla slow / what's running? | — | `docker_ps` + `rdctl_info` cover the basics |
| 🟡 Show me my full conversation history | `browser/search_conversations` | Scope includes chats / browser visits / workflow executions |
| 🟢 Export my memory / observations | — | No export tool |

---

## Environment gaps (all rows re-verified live 2026-08-14)

| Thing | Status | What it means for the agent |
|-------|--------|----------------------------|
| **Twenty CRM server** | 🟢 Not deployed | **Re-verified 2026-08-14:** the Twenty CRM stack has been REMOVED — no `twenty-crm-server` / `twenty-crm-postgres` containers exist (13 containers up, none Twenty) and no Twenty extension is installed. The old "restart-loop" fact is dead. Don't assume a CRM is running; if a user wants Twenty, install it fresh via the marketplace. |
| **`workflows` table** | 🟢 Populated | **Re-verified 2026-08-14:** 5 `production` + 7 `draft` + 1 `archive`. The old "0 production, only 2 drafts" state is gone — the operator/EA machinery (daily briefing, weekly review, planning routes, etc.) is registered. Run `SELECT status, count(*) FROM workflows GROUP BY status` for the live picture; don't assume the table is empty. |
| **Heartbeat** | 🟡 Off by default; dual-store read hazard | Ships `heartbeatEnabled=false`. **Gotcha (verified 2026-08-14):** the flag lives in BOTH Postgres (`sulla_settings` via `SullaSettingsModel`) and Redis, and they can drift — a UI save or a transient boot throw has flipped Redis to `false` while PG held `true`, silently killing autonomous runs. Always toggle through `SullaSettingsModel` (never raw Redis `hset`), and treat the model read as authoritative. Fix #1 (bootstrap fail-loud on settings-DB init) is staged as PR #560, not yet merged. |
| **Observational memory** | 🟢 No cap | **Re-verified 2026-08-14:** the old "50 entries, oldest auto-pruned" fact is dead. Since migration 0028, observations live in a relational `observations` table with **no storage cap and no auto-prune** — `add_observational_memory` states "No 50-cap pruning — observations are never automatically removed", and removal (`remove_observational_memory`) only soft-archives (`archived=true`), never hard-deletes, so history is always recoverable. The system prompt injects only the **top-10 active** rows (`TOP_N=10`, by priority+recency) — a *display* cap, not a storage limit. Add freely; dedup updates a substantially-similar active row instead of inserting a duplicate. |
| **`rdctl_shell` arg handling** | 🟡 Limited | **Re-verified 2026-08-14 against source:** still no pipes, redirects, `&&`, `\|`. The tool passes `command` as a single argv element (`['shell', '--', command]`) to `spawn('rdctl', …, { shell: false })` (`rdctl_shell.ts`, `CommandRunner.ts:61`) — no shell interprets it, so metacharacters are literal, not operators. Single command + args only; use multi-step if you need a pipe. |

---

## Top 5 highest-leverage tools (all shipped)

All five closed:

1. ~~`ui/open_tab`~~ — ✅ shipped
2. ~~Workflow stop/cancel~~ — ✅ shipped (`meta/stop_workflow` + pause/resume/dry_run)
3. ~~Function run history~~ — ✅ shipped (`function_runs` table + `function/function_runs` tool)
4. ~~Vault delete-credential~~ — ✅ shipped (`vault/vault_delete_credential`)
5. ~~Mobile-routed `notify_user`~~ — ✅ shipped (desktop leg + mobile leg; needs sulla-workers `/push/{user_id}` route deployed for the mobile leg to actually land)

## Next batch — biggest real gaps still open

1. **Live workflow state stream** — "what's the workflow doing right now?" (only post-hoc checkpoints today)
2. **Per-behavior heartbeat toggles** — currently all-or-nothing
3. **Marketplace cloud worker** (sulla-cloud) — so publish / unpublish actually work end-to-end
4. **Mobile push relay** (sulla-workers) — the `/push/{user_id}` leg for targets:["mobile"]
5. **OAuth-flow tooling for integrations** — "connect my Slack" without leaving chat

---

## How to use this doc

When a user asks for something, **before you start building a workaround**:

1. Skim this doc — is the request listed?
2. If yes, tell them honestly: "There's no tool for that yet — the closest I can do is X."
3. Don't fake the action and then quietly fail.
4. If the gap is hurting them often, suggest they raise it (Jonathon prioritizes from real friction).

If you find a new gap not listed here, add it — this doc is the agent's standing punch list.
