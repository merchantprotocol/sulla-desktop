# Known Gaps — User Requests Without a Tool

When a user asks for one of these, **don't pretend it works**. Say there's no tool for that yet, and offer the closest workaround. Tell Jonathon when a gap keeps coming up, since he sets priorities from real friction. This doc keeps you honest.

Severity: 🔴 high (likely to come up often) · 🟡 medium · 🟢 occasional

Checked against the live tool registry on 2026-10-19. Items marked *(unverified)* weren't confirmed in code.

---

## UI Navigation (cross-cutting)

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Open the marketplace | `sulla ui/open_tab '{"mode":"marketplace"}'` | |
| ✅ Open my vault / integrations / routines / history / secretary | `sulla ui/open_tab '{"mode":"<mode>"}'` | |
| ✅ Open Settings | `sulla ui/open_tab '{"mode":"settings"}'` | Opens the Preferences window |
| ✅ Open Twenty CRM or any extension web UI | `sulla browser/tab '{"action":"upsert","url":"..."}'` | Extension UIs are external URLs |
| 🟡 Show me the specific workflow I just created | `ui/open_tab '{"mode":"routines"}'` opens the index | No per-item deep link |

---

## Workflows

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Stop / cancel a running workflow | `sulla meta/stop_workflow '{"executionId":"..."}'` | Cooperative. Takes effect at the next step, or when the current call returns |
| ✅ Pause this workflow, I'll resume later | `sulla meta/pause_workflow` + `sulla meta/resume_workflow` | In-flight work isn't cancelled |
| ✅ Test a workflow without running it for real | `sulla meta/dry_run_workflow '{"slug":"..."}'` | Static walk. Reports execution order and orphans |
| 🔴 Show what my workflow is doing right now | — | Only the post-hoc checkpoint trail exists *(unverified: no live state stream)* |
| 🟡 Show me the workflow visually | `sulla workflow/display_workflow '{"slug":"..."}'` prints a text view of the nodes and edges | No inline graphic. `ui/open_tab '{"mode":"routines"}'` opens the canvas |
| 🟢 List my workflows | `sulla pg/query '{"sql":"SELECT name, status FROM workflows ORDER BY status, name"}'` | No flat list tool |
| ✅ Schedules and status | `sulla workflow/routine_report`, `workflow/refresh_schedules`, `workflow/catch_up_schedules`, `workflow/set_workflow_status` | `set_workflow_status` re-arms the scheduler and reports the cron state |

---

## Functions

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Show me past runs of function X | `sulla function/runs '{"slug":"..."}'` | Every invocation is recorded |
| ✅ Why did my function fail yesterday? | `sulla function/runs '{"slug":"...","only_failures":true,"verbose":true}'` | Records the error stage and the error |
| ✅ Scaffold a function from a template | `sulla marketplace/scaffold '{"kind":"function","slug":"...","runtime":"python"}'` | |
| 🟡 Schedule this function to run daily | — | Wrap it in a workflow with a `schedule` trigger |
| 🟡 Run in the background / async | — | `function/run` has no async flag. It takes `slug`, `inputs`, and `version` |
| 🟡 Stream the output | — | No streaming. The full result comes back at completion |

---

## Vault

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Delete this credential | `sulla vault/delete_credential '{"account_type":"...","property":"...","confirm":true}'` | `confirm` is required |
| 🔴 Connect my Slack or another service via OAuth | — | The agent can't run OAuth. Send the user to Settings |
| 🟡 Rotate this API key | — | No rotation tool. `vault/set_credential` overwrites the value |
| 🟡 Import from 1Password / LastPass | — | No import |
| 🟢 Export all my credentials for backup | — | No export. That's deliberate |

---

## Marketplace / Extensions

The `marketplace/*` tools (11, across skill / function / routine / recipe / integration; `agent` is local-only) talk to the live Sulla Cloud marketplace. `extensions/*` covers install, uninstall, start, stop, and status. Publish, unpublish, and list_published need a Sulla Cloud session. Reads work without one *(unverified)*.

| Request | Severity | Status |
|---------|----------|--------|
| ✅ Update an extension to the latest | `sulla extensions/install_extension` with the new tag, or `marketplace/update` for non-recipe artifacts | |
| ✅ Start / stop a recipe | `sulla extensions/start_extension '{"id":"..."}'` / `stop_extension '{"id":"...","confirm":true}'` | |
| ✅ Build me a new recipe / skill / function / workflow / agent | `sulla marketplace/scaffold '{"kind":"...","slug":"..."}'` | |
| ✅ Validate before publishing | `sulla marketplace/validate '{"kind":"...","slug":"..."}'` | |
| ✅ Publish to marketplace | `sulla marketplace/publish '{"kind":"...","slug":"..."}'` | Needs a Sulla Cloud sign-in. The submission is pending until an admin approves it |
| ✅ Compare local vs marketplace | `sulla marketplace/diff '{"kind":"...","slug":"..."}'` | |
| 🟡 Restart in one call | No `restart` tool. Compose `stop_extension` and `start_extension` | |
| 🟢 Notify me when new artifacts appear | No watch | |
| 🟢 Install from a private registry | Unverified | |

---

## Calendar

The seven `calendar/*` tools create, get, list, list_upcoming, update, cancel, and delete single events.

| Request | Severity | Status |
|---------|----------|--------|
| Sync with Google Calendar / iCal | 🔴 | No calendar sync tool |
| Make this meeting recurring (every Tuesday) | 🔴 | No recurrence. Workaround: create one event per occurrence |
| Email the attendees | 🔴 | `people` is stored on the event. Nothing is sent *(unverified)* |
| Add a Zoom / Meet link | 🟡 | No conferencing integration |
| Snooze this reminder | 🟡 | No snooze. Update the event's time with `calendar/update` |
| Attach a file to the event | 🟢 | No attachments |

---

## Notifications

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Notify my phone too | `sulla notify/user '{"title":"...","message":"...","targets":["desktop","mobile"]}'` | The mobile leg posts to sulla-workers `/push/{user_id}`. The backend route has to be deployed *(unverified)* |
| ✅ Show me missed notifications | `sulla notify/history '{"only_failures":true}'` | |
| 🔴 Reply directly from a notification | — | No action buttons |
| 🟡 Send me a text / email when X | — | Targets are `desktop` and `mobile` only. No SMS or email |
| 🟢 Snooze a notification | — | No primitive |

---

## Heartbeat

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Only run between 9am and 5pm on weekdays | `sulla settings/set '{"property":"heartbeatWindow","value":"<json>","cast":"json"}'` | The window fields are `days`, `startHour`, `endHour`, and `tz` |
| 🟡 Disable just one heartbeat behavior | — | All or nothing. No per-behavior toggle |

---

## Docker / Lima / Kubernetes

The docker category has nine tools: build, exec, images, logs, ps, pull, rm, run, and stop.

| Request | Severity | Status |
|---------|----------|--------|
| Open an interactive shell into a container | 🔴 | `docker/exec` runs one command. No PTY |
| Restart Postgres / Redis / a runtime safely | 🔴 | Owned by ServiceLifecycleManager. The only path is restarting Desktop |
| Show CPU / memory / disk usage | 🟡 | No stats tool |
| Inspect a container's config / env | 🟡 | No inspect tool |
| Clean up unused images | 🟡 | No prune tool |
| Stream pod logs | 🟢 | No streaming |
| Manage compose stacks directly | 🟢 | Only through the extensions API |

---

## Browser

| Request | Severity | Status |
|---------|----------|--------|
| Download this file from the page | 🟡 | Unverified whether this works cleanly |
| Save page as PDF | 🟡 | No print-to-PDF helper |
| Record my browsing session | 🟢 | No |

---

## Computer Use (full pixel-level OS control)

| Request | Severity | Status |
|---------|----------|--------|
| Click anywhere on my screen (outside the browser) | 🔴 | Not built. No OS-level pointer tool. Planned Phase 2 |
| Type into a non-browser app | 🟡 | No pixel-level typing. AppleScript may send keystrokes to an enabled app *(unverified)* |
| Drag and drop on the desktop | 🟡 | Not built |
| Multi-display interaction | 🟡 | Planned |
| Computer-use confirmation UI / kill switch | 🟡 | Planned *(unverified)* |

**What's available today:**
- Screenshots of the primary display, or of a chosen screen or window: `capture/screenshot` with `capture/list_screens`.
- AppleScript app control for apps the user has enabled per app: `applescript/computer_use_list`, `computer_use_enable`, and `computer_use_disable`, plus `applescript/execute`.
- Browser pixel control: `browser/click_at`, `browser/type_at`, and `browser/screenshot`.

---

## AppleScript

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Audit log of past AppleScript executions | `sulla applescript/audit_log '{"only_failures":true}'` | |
| 🔴 Run shell from inside AppleScript (`do shell script`) | — | Blocked for security. Won't change |
| 🔴 Use `with administrator privileges` | — | Blocked for security *(unverified: the admin-privileges check)* |

---

## Capture Studio

| Request | Severity | Status |
|---------|----------|--------|
| ✅ Take a screenshot | `sulla capture/screenshot '{}'` | Primary display. Pass `sourceId` for a screen or window |
| ✅ List screens / windows | `sulla capture/list_screens '{"kind":"window"}'` | |
| ✅ Start / stop microphone capture | `sulla capture/mic_start` / `mic_stop` | Ref-counted |
| ✅ Start / stop desktop-audio loopback | `sulla capture/speaker_start` / `speaker_stop` | |
| ✅ Drive the teleprompter | `sulla capture/teleprompter_*` (open, close, script, style, status) | |
| ✅ Check audio capture state | `sulla capture/audio_state` | |
| ✅ Start / stop a multi-source recording | `sulla capture/recorder_start` / `recorder_stop` / `recorder_status` | Takes optional `screen`, `camera`, `mic`, and `speaker` |
| ✅ Add a screen or camera mid-session | `sulla capture/screen_set '{"sourceId":"..."}'`, `camera_list`, `camera_set`, `camera_release` | |
| 🔴 Open the Capture Studio window | — | No `capture-studio` mode in `ui/open_tab` |
| 🟡 Get the path of my last recording session | — | No dedicated tool. `meta/exec` and `ls ~/sulla/captures/` work *(unverified: whether `recorder_status` returns the path)* |
| 🟡 Transcribe a saved recording | — | Whisper is wired for live capture only. Write a custom function for batch files |

⚠️ BlackHole loopback doesn't capture system audio on macOS 15. `speaker_start` runs, but it won't capture anything until an alternative ships. The mic and screenshots work.

---

## Secretary Mode

| Request | Severity | Status |
|---------|----------|--------|
| ✅ Start secretary mode | `sulla secretary/start '{}'` | Also works from `Cmd+Shift+S` and the tray |
| ✅ Stop secretary mode | `sulla secretary/stop '{}'` | |
| ✅ Is it running? | `sulla secretary/status '{}'` | |
| 🟡 Get my last meeting notes | — | No retrieval tool. Transcripts are in chat history with no clean query |
| 🟢 "What was the action item from earlier?" | — | The wake word works. The agent has no structured query into the analysis output |

---

## Sulla Mobile (paired iOS app)

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Is my phone paired / reachable right now? | `sulla mobile/list_devices '{"online_only":true,"device_type":"mobile"}'` | Online means the device hit the worker in the last 2 minutes. Check this before you route to the phone |
| ✅ Send a notification to my phone | `sulla notify/user '{"targets":["mobile"]}'` | Needs the backend push route |
| 🔴 Pair my phone via QR code | — | Manual sign-in on both devices today |
| 🔴 Sync calendar to mobile | — | Mobile keeps its own server-side data. No shared calendar |

---

## Sulla Cloud

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Sign me up for Cloud | Point the user to the Sulla Cloud card in the marketplace view: `sulla ui/open_tab '{"mode":"marketplace"}'` | |
| 🔴 Show me my Cloud usage / bill | — | No usage API. No tool |
| 🟡 Pause / cancel my Cloud subscription | — | Tier changes happen in the card UI |
| 🟡 Migrate my Desktop setup to Cloud | — | No migration tool |

---

## GitHub

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Merge this PR | `sulla github/merge_pr '{"owner":"...","repo":"...","pull_number":N,"confirm":true}'` | Merge, squash, or rebase |
| ✅ Show CI status for this branch | `sulla github/check_runs '{"owner":"...","repo":"...","ref":"..."}'` | Status, conclusion, and timing for each run |
| ✅ Trigger a GitHub Action | `sulla github/trigger_workflow_run '{"owner":"...","repo":"...","workflow_id":"ci.yml","inputs":{...}}'` | Needs a `workflow_dispatch` trigger in the target workflow |
| 🟡 AI-review this PR | Partial | No one-shot review tool. Pull the diff with `github/get_pr_files`, write the review, then post it with `github/add_pr_review`. `github/list_pr_reviews` reads existing reviews |

---

## General / Cross-cutting

| Request | Status | Notes |
|---------|--------|-------|
| ✅ Update Sulla Desktop | electron-updater. Runs automatically | No agent tool. The user installs from the Updates UI |
| 🔴 Backup my whole Sulla setup | — | No backup tool. `~/sulla/`, `~/.sulla/`, and a Postgres dump are manual |
| 🟡 Show me my full conversation history | `sulla browser/search_conversations` | Covers chats, browser visits, and workflow executions |
| 🟢 Export my memory / observations | — | No export tool |
| ✅ Tell me when the background job finishes | Claude Code `Bash run_in_background` or `Monitor` *(unverified: harness behavior)* | Sub-agent and workflow-worker runs aren't woken after they return. Wait inside the turn instead |

---

## Environment gaps

| Thing | Status | What it means for the agent |
|-------|--------|----------------------------|
| **Twenty CRM** | 🟢 Not installed by default | Don't assume a CRM is running. Check `sulla extensions/list_installed_extensions` *(unverified: whether Twenty is still in the catalog)* |
| **`workflows` table** | 🟢 Populated | Don't assume it's empty or full. Check with `sulla pg/query '{"sql":"SELECT status, count(*) FROM workflows GROUP BY status"}'` |
| **Heartbeat** | 🟡 Off by default | Change it only through `sulla settings/set`. That goes through SullaSettingsModel. Don't write Redis directly |
| **Observational memory** | 🟢 No cap | Nothing is auto-pruned. `add_observational_memory` adds a row, or updates a close match instead of adding a duplicate. `remove_observational_memory` archives a row and never hard-deletes it. Only the top 10 active rows are injected into the prompt |

---

## Biggest open gaps

1. **Live workflow state stream.** "What's the workflow doing right now?" The only data is the post-hoc checkpoint trail.
2. **Per-behavior heartbeat toggles.** The heartbeat is still all or nothing.
3. **Mobile push relay.** The backend `/push/{user_id}` route has to be live for `targets:["mobile"]` to land.
4. **OAuth-flow tooling for integrations.** "Connect my Slack" can't be done from chat.

---

## How to use this doc

When a user asks for something, **before you start building a workaround**:

1. Skim this doc. Is the request listed?
2. If it is, tell them honestly: "There's no tool for that yet. The closest I can do is X."
3. Don't fake the action and then fail quietly.
4. If the gap keeps hurting them, suggest they raise it.

If you find a gap that isn't listed here, add it. This doc is the agent's standing punch list.


Projects are plain files. See [Projects in Files](../environment/projects-in-files.md).
