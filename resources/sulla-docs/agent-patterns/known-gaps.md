# Known Gaps — User Requests Without a Tool

When a user asks for one of these, **don't pretend it works**. Either say "no tool for that yet" and offer the closest workaround, or escalate to Jonathon. This doc keeps you honest.

Severity: 🔴 high (likely to come up often) · 🟡 medium · 🟢 occasional

Last verified against the codebase: 2026-04-23.

---

## UI Navigation (cross-cutting)

**Resolved (2026-04-23):** [`sulla ui/open_tab`](../tools/ui.md) now bridges the renderer's `agent-command` IPC. All built-in views are openable from chat.

| Request | Status | Notes |
|---------|--------|-------|
| ✅ "Open the marketplace" | `sulla ui/open_tab '{"mode":"marketplace"}'` | |
| ✅ "Open my vault / integrations / routines / history / secretary" | `sulla ui/open_tab '{"mode":"<mode>"}'` | |
| ✅ "Open Twenty CRM" | `sulla browser/tab '{"url":"..."}'` | extension web UIs use browser/tab |
| 🟡 "Show me the specific workflow I just created" | `ui/open_tab '{"mode":"routines"}'` opens the index | per-item deep-link not exposed yet |
| 🔴 "Open settings" | No tool | Settings is a separate window, not a tab mode |
| 🔴 "Open Computer Use Settings" | No tool | Same |

---

## Workflows

| Request | Severity | Status |
|---------|----------|--------|
| Stop / cancel a running workflow | 🔴 | No public stop tool. Only the orchestrating agent can self-abort via `⛔ ABORT`. Hard kill = restart Desktop |
| Show what my workflow is doing right now | 🔴 | Only post-hoc checkpoint trail; no live state inspection |
| Pause this workflow, I'll resume later | 🟡 | No pause primitive |
| Test a workflow without running it for real | 🟡 | No dry-run / mock mode |
| Show me the workflow visually | 🟡 | No CLI graph rendering; must open canvas (which is its own gap above) |
| List my workflows / what's scheduled | 🟢 | Works but requires direct model/service calls; no CLI tool |

---

## Functions

| Request | Severity | Status |
|---------|----------|--------|
| Show me past runs of function X | 🔴 | No persistent run history |
| Why did my function fail yesterday? | 🔴 | Logs are ephemeral (HTTP response only) |
| Schedule this function to run daily | 🟡 | Wrap it in a workflow with a `schedule` trigger |
| Run in the background / async | 🟡 | `function_run` blocks |
| Stream the output | 🟡 | No streaming |
| Scaffold a function from a template | 🟢 | No scaffolder; agent writes from scratch |

---

## Vault

| Request | Severity | Status |
|---------|----------|--------|
| Connect my Slack/etc via OAuth | 🔴 | Agent can't run OAuth. Direct user to Settings |
| Delete this credential | 🔴 | No dedicated delete tool. Blank fields manually |
| Rotate this API key | 🟡 | No rotation tool |
| Import from 1Password / LastPass | 🟡 | No import |
| Export all my credentials for backup | 🟢 | No export (defensible, but users will ask) |

---

## Marketplace / Extensions

The `marketplace/*` (10 tools, generic across 5 kinds) and `extensions/{start,stop,get_status}_extension` shipped 2026-04-23.

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

| Request | Severity | Status |
|---------|----------|--------|
| Notify my phone too | 🔴 | `notify_user` is desktop-only. Mobile gets push from the receptionist backend, not from `notify_user` |
| Reply directly from notification | 🔴 | No action buttons |
| Send me a text / email when X | 🟡 | No SMS/email channel |
| Show me missed notifications | 🟡 | No notification history |
| Snooze | 🟢 | No primitive |

---

## Heartbeat

| Request | Severity | Status |
|---------|----------|--------|
| Only run between 9am–5pm weekdays | 🟡 | No time-window config; all-or-nothing |
| Disable just one heartbeat behavior | 🟡 | No per-behavior toggle |
| Standing goal that survives restart | 🟢 | Only via observational memory, not first-class |

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

| Request | Severity | Status |
|---------|----------|--------|
| Run shell from inside AppleScript (`do shell script`) | 🔴 | **Blocked for security** — won't change |
| Use `with administrator privileges` | 🔴 | **Blocked for security** — won't change |
| AppleScript for an app not in the allowlist | 🟡 | Add the app to `pkg/rancher-desktop/main/computerUseSettings/appRegistry.ts` first |
| Open Computer Use Settings UI from chat | 🟡 | UI navigation gap — same as marketplace/vault/etc. |
| Audit log of past AppleScript executions | 🟢 | No log surface today |

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

| Request | Severity | Status |
|---------|----------|--------|
| Pair my phone via QR code | 🔴 | Phase 2, not yet. Manual: sign in on phone with the same account |
| Send a file from desktop to phone | 🔴 | No transfer mechanism |
| Sync calendar to mobile | 🔴 | Mobile has its own server-side data; no shared calendar today |
| Send a notification to my phone | 🔴 | `notify_user` is desktop only. Mobile push comes from the receptionist backend, not the agent |
| "Show me my last call from mobile" | 🟡 | Agent can hit the mobile API via the same Cloudflare Workers backend (auth needed) but no dedicated tool wraps it |
| Take over a live call from desktop | 🟡 | Only the phone can. No desktop-side takeover |

---

## Sulla Cloud

| Request | Severity | Status |
|---------|----------|--------|
| Sign me up for Cloud / Enterprise Gateway | 🔴 | No provisioning tool. Out-of-band (Jonathon) |
| Show me my Cloud usage / bill | 🔴 | No billing tool |
| Pause / cancel my Cloud subscription | 🟡 | No |
| Migrate my Desktop setup to Cloud | 🟡 | No migration tool |

---

## GitHub

| Request | Severity | Status |
|---------|----------|--------|
| Merge this PR | 🟡 | Unclear if `github_merge_pr` exists; verify before claiming |
| Show CI status for this branch | 🟡 | No Checks API tool |
| Trigger a GitHub Action | 🟡 | No |
| AI-review this PR | 🟢 | No review tool — would have to spawn an agent against the diff manually |

---

## General / Cross-cutting

| Request | Severity | Status |
|---------|----------|--------|
| Update Sulla Desktop | 🔴 | Likely no in-app updater; download new DMG manually. Verify before claiming |
| Backup my whole Sulla setup | 🔴 | No backup tool. `~/sulla/` + `~/.sulla/` + Postgres dump = manual |
| Migrate to a new machine | 🔴 | No migration tool |
| Why is Sulla slow / what's running? | 🟡 | No perf inspection beyond `docker_ps` |
| Show me my full conversation history | 🟡 | `browser/search_conversations` exists but unclear scope |
| Export my memory / observations | 🟢 | No export tool |

---

## Environment gaps (verified live 2026-04-23)

| Thing | Status | What it means for the agent |
|-------|--------|----------------------------|
| **n8n** | 🔴 Not running | Tool surface (`sulla n8n/*`) exists, but there's no n8n container. Check `vault/vault_is_enabled '{"account_type":"n8n"}'` first. |
| **Twenty CRM server** | 🟡 Broken | Container `twenty-crm-server` is in restart loop. Postgres for it (`twenty-crm-postgres`) is healthy on port 30208. |
| **`workflows` table** | 🟡 Empty (of production) | Only 2 draft workflows exist. `status='production'` returns nothing. Don't assume workflows are already set up. |
| **Heartbeat** | 🟡 Disabled by default | `heartbeatEnabled=false` in `sulla_settings`. Tell the user how to enable if they want autonomous runs. |
| **Observational memory cap** | 🟡 | 50 entries. When full, the oldest is auto-pruned. |
| **`rdctl_shell` arg handling** | 🟡 Limited | No pipes, redirects, `&&`, `\|`. Single command + args only. Use multi-step if needed. |

---

## Top 5 highest-leverage tools to build

If we ship these, the gap surface shrinks dramatically:

1. ~~**`ui/open_tab`**~~ — ✅ shipped 2026-04-23
2. **Workflow stop/cancel tool** — current state forces a Desktop restart
3. **Function run history** — debugging is painful without it
4. **Vault delete-credential tool** — UI-only today
5. **Mobile-routed `notify_user`** — extends notifications to the paired phone via the existing Cloudflare relay

---

## How to use this doc

When a user asks for something, **before you start building a workaround**:

1. Skim this doc — is the request listed?
2. If yes, tell them honestly: "There's no tool for that yet — the closest I can do is X."
3. Don't fake the action and then quietly fail.
4. If the gap is hurting them often, suggest they raise it (Jonathon prioritizes from real friction).

If you find a new gap not listed here, add it — this doc is the agent's standing punch list.
