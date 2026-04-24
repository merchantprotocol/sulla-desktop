# Known Gaps — User Requests Without a Tool

When a user asks for one of these, **don't pretend it works**. Either say "no tool for that yet" and offer the closest workaround, or escalate to Jonathon. This doc keeps you honest.

Severity: 🔴 high (likely to come up often) · 🟡 medium · 🟢 occasional

Last verified against the codebase: 2026-04-23.

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
| 🟡 Show me the workflow visually | — | Open the canvas via `ui/open_tab '{"mode":"routines"}'`; no CLI rendering |
| 🟢 List my workflows / what's scheduled | — | Works but requires direct model/service calls; no CLI tool |

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
| Sync with Google Calendar / iCal | 🔴 | No GCal integration |
| Make this meeting recurring (every Tuesday) | 🔴 | No native RRULE. Workaround: create N events |
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
| 🟢 Standing goal that survives restart | — | Only via observational memory |

---

## Docker / Lima / Kubernetes

| Request | Severity | Status |
|---------|----------|--------|
| Open an interactive shell into a container | 🔴 | `docker_exec` runs commands; no PTY |
| Restart Postgres / Redis / a runtime safely | 🔴 | Owned by ServiceLifecycleManager; only path is restart Desktop |
| Show CPU / memory / disk usage | 🟡 | No `docker_stats` |
| Inspect a container's config / env | 🟡 | No `docker_inspect` |
| Clean up unused images | 🟡 | No `docker_system_prune` |
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

The `capture/*` category (13 tools) shipped 2026-04-23 and closes most of the headless control gaps. Multi-source recording is still renderer-side and not agent-controllable.

| Request | Severity | Status |
|---------|----------|--------|
| ✅ Take a screenshot | `sulla capture/screenshot '{}'` | shipped |
| ✅ List screens / windows | `sulla capture/list_screens '{}'` | shipped |
| ✅ Start / stop microphone capture | `sulla capture/mic_start` / `mic_stop` (ref-counted) | shipped |
| ✅ Start / stop desktop-audio loopback | `sulla capture/speaker_start` / `speaker_stop` | shipped |
| ✅ Drive the teleprompter | `sulla capture/teleprompter_*` (open/close/script/style/status) | shipped |
| ✅ Check audio capture state | `sulla capture/audio_state` | shipped |
| 🔴 Start / stop a multi-source recording session | Renderer-side MediaRecorder; needs renderer command bus that isn't built |
| 🔴 Open the Capture Studio window | UI navigation gap — `ui/open_tab` doesn't have a `capture-studio` mode yet |
| 🟡 Add screen + camera to current scene mid-session | Same renderer-side limitation |
| 🟡 Get the path of my last recording session | No dedicated tool — `meta/exec` + `ls ~/sulla/captures/` works |
| 🟡 Transcribe a saved recording | Whisper is wired for live, not retroactive batch — write a custom function |

⚠️ **BlackHole broken on macOS 15** — `speaker_start` won't actually capture system audio until alternative loopback ships. Mic and screenshots still work fine.

---

## Secretary Mode

| Request | Severity | Status |
|---------|----------|--------|
| Start secretary mode | 🟡 | No agent tool — user presses `Cmd+Shift+S` or tray menu |
| Stop secretary mode | 🟡 | Same — UI-driven |
| Get my last meeting notes | 🟡 | No dedicated retrieval tool — meeting transcripts are in chat history but no clean query |
| "Hey Sulla, what was the action item from earlier?" | 🟢 | Wake word works but the agent has no structured query into the analysis output |

Secretary Mode itself is **shipped and works** — but it's user-controlled, not agent-controlled.

---

## Sulla Mobile (paired iOS app)

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Show me my last call from mobile | `sulla mobile/list_calls` + `sulla mobile/get_call '{"id":"..."}'` | Hits sulla-workers with the mobile JWT from vault `sulla-cloud/api_token` |
| ✅ Show me my leads | `sulla mobile/list_leads` | Inbox contents with urgency/qualified filters |
| ✅ Show me my messages | `sulla mobile/list_messages` | SMS + voicemail transcripts |
| ✅ Send a notification to my phone | `sulla notify/notify_user '{"targets":["mobile"]}'` | sulla-workers `/push/{user_id}` leg needed |
| 🔴 Pair my phone via QR code | — | Phase 2 of pairing; manual (same account sign-in) today |
| 🔴 Send a file from desktop to phone | — | No transfer mechanism |
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
| ✅ Merge this PR | `sulla github/github_merge_pr '{"owner":"...","repo":"...","pull_number":N,"confirm":true}'` | merge / squash / rebase methods |
| ✅ Show CI status for this branch | `sulla github/github_check_runs '{"owner":"...","repo":"...","ref":"..."}'` | Lists runs with status + conclusion + timing |
| ✅ Trigger a GitHub Action | `sulla github/github_trigger_workflow_run '{"owner":"...","repo":"...","workflow_id":"ci.yml","inputs":{...}}'` | Requires workflow_dispatch trigger in the target workflow |
| 🟢 AI-review this PR | — | No review tool; spawn an agent against the diff manually |

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

## Environment gaps (verified live 2026-04-23)

| Thing | Status | What it means for the agent |
|-------|--------|----------------------------|
| **Twenty CRM server** | 🟡 Broken | Container `twenty-crm-server` is in restart loop. Postgres for it (`twenty-crm-postgres`) is healthy on port 30208. |
| **`workflows` table** | 🟡 Empty (of production) | Only 2 draft workflows exist. `status='production'` returns nothing. Don't assume workflows are already set up. |
| **Heartbeat** | 🟡 Disabled by default | `heartbeatEnabled=false` in `sulla_settings`. Tell the user how to enable if they want autonomous runs. |
| **Observational memory cap** | 🟡 | 50 entries. When full, the oldest is auto-pruned. |
| **`rdctl_shell` arg handling** | 🟡 Limited | No pipes, redirects, `&&`, `\|`. Single command + args only. Use multi-step if needed. |

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
