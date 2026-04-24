# User Stories — Request → Action Playbook

Common user requests and how the agent should handle them. Each has: **what they're really asking**, **plan**, **tools/files**. Read this when a request maps cleanly to a category — don't reinvent the plan from scratch every time.

If the request is ambiguous, **ask one clarifying question, then act**. Don't wall-of-text plan or batch questions.

---

## Workflows

### "Build me a workflow that does X"
**Plan:**
1. Talk through the trigger, steps, routing, and failure mode in 2–4 turns. Don't write YAML until aligned.
2. Read `~/sulla/resources/environment/create-workflow.md` (canonical authoring rules).
3. Draft the YAML per `workflows/schema.md` and `workflows/node-types.md`.
4. Validate: `sulla meta/validate_sulla_workflow '{"yaml":"..."}'`
5. Save to `~/sulla/routines/<slug>/routine.yaml` (template) or `~/sulla/workflows/<slug>.yaml` (flat-file).
6. Activate to test: `sulla meta/execute_workflow '{"workflowId":"<slug>"}'`
7. Watch `~/sulla/logs/playbook-debug.log` for the run.

See: [`workflows/authoring.md`](../workflows/authoring.md)

### "Validate this workflow"
```bash
sulla meta/validate_sulla_workflow '{"filePath":"..."}'
```
Returns `ValidationIssue[]`. Surface errors with their `path` so the user can fix.

### "Why did my workflow fail?" / "Debug my workflow"
**Plan:**
1. Get the `executionId` (ask, or query recent runs via `WorkflowCheckpointModel.recentExecutions(workflowId, 5)`)
2. `grep "<executionId>" ~/sulla/logs/playbook-debug.log`
3. `WorkflowCheckpointModel.findByExecution(executionId)` — see what completed
4. The failed node is the one **after** the last checkpoint
5. Inspect the last checkpoint's `node_output` for context the failed node received

### "How did workflow X run today?" / "Show me the history"
Query `WorkflowCheckpointModel.recentExecutions(workflowId, 10)`. For each run, optionally pull the full checkpoint trail with `findByExecution()`.

### "Restart workflow X from where it failed"
```bash
sulla meta/restart_from_checkpoint '{"workflowId":"X"}'                # list runs
sulla meta/restart_from_checkpoint '{"executionId":"wfp-..."}'         # list checkpoints
sulla meta/restart_from_checkpoint '{"executionId":"wfp-...","nodeId":"failed-node"}'
```

### "Schedule workflow X to run daily at 9am"
Add a `schedule` trigger node to the workflow definition (frequency: daily, hour: 9, minute: 0, timezone: ...). Promote to `production`. WorkflowSchedulerService picks it up automatically.

### "Run workflow X now"
```bash
sulla meta/execute_workflow '{"workflowId":"X","message":"optional payload"}'
```
Returns the `executionId`. Run is async — watch the playbook log.

### "List my workflows"
No CLI tool. Use `WorkflowModel.listAll()` or `listByStatus('production'|'draft'|'archive')`.

### "What's scheduled to run?"
`WorkflowSchedulerService.getInstance().getScheduledJobs()` — returns each registered cron with `nextInvocation`.

### "Stop / cancel a running workflow"
No public stop tool. Either let it finish, or restart the Desktop app (heavy hammer — warn the user). The agent CAN abort by emitting `⛔ ABORT` in its response if it's the orchestrating agent.

### "Archive / delete workflow X"
Set DB row's `status` to `archive` (preserves history). Or remove the row entirely. The scheduler auto-deregisters cron jobs on workflow refresh.

---

## Functions

### "Build me a custom function that does X"
**Plan:**
1. Confirm: what does it take in, what does it return, which runtime (python / node / shell)?
2. Pick a slug (kebab-case).
3. Create `~/sulla/functions/<slug>/`
4. Write `function.yaml` per `functions/schema.md`
5. Write the handler per `functions/runtimes.md` (signature must match)
6. Add `requirements.txt` / `package.json` / `packages.txt` if there are deps
7. Test: `sulla function/function_run '{"slug":"<slug>"}'`

See: [`functions/authoring.md`](../functions/authoring.md)

### "Run my function X"
```bash
sulla function/function_run '{"slug":"X","inputs":{...}}'
```

### "What functions do I have?"
```bash
sulla function/function_list '{}'
```

### "Why did my function fail?"
1. `function_list` — confirms it parses
2. `function_run` with same inputs — read the full trace in `responseString`
3. Look for the category prefix: parse error, dep install fail, load fail, invocation fail
4. Open the handler, check signature + return shape against `spec.outputs`

### "Show me the source of function X"
Read `~/sulla/functions/X/function.yaml` and the handler file. No dedicated tool — it's just files.

### "Edit function X"
Modify files in place. **Bump the `version` field** in `function.yaml` so the runtime cache reloads (or pass explicit `version` to `function_run`).

### "Delete function X"
`rm -rf ~/sulla/functions/X` — confirm first, especially if the dir has a `.git` directory.

---

## Vault & Credentials

### "Connect my GitHub / Slack / etc."
The agent doesn't run OAuth itself. Direct the user to Settings → Integrations → [service] → Connect. After they confirm, verify with `sulla vault/vault_is_enabled '{"account_type":"github"}'`.

For raw API keys (no OAuth), use `vault_set_credential`.

### "What integrations do I have connected?"
For each integration: `sulla vault/vault_list_accounts '{"account_type":"X"}'`. Or just answer based on what the user said + spot-check.

### "Use my GitHub PAT to call the API"
**Don't read the secret.** Use the proxy pattern:
```bash
sulla github_account_id/github '{"method":"GET","path":"/user/repos"}'
```
Vault injects credentials automatically.

### "Show me my OpenAI key"
Only when the user explicitly asked to see/copy:
```bash
sulla vault/vault_read_secrets '{"account_type":"openai","include_secrets":true}'
```

### "Autofill my password on this site"
```bash
sulla vault/vault_autofill '{"origin":"https://github.com"}'
```
Password is injected into the active tab — never returned to the agent.

### "Save my password for this site"
```bash
sulla vault/vault_set_credential '{"account_type":"website","property":"password","value":"...","account_id":"github.com"}'
```

See: [`tools/vault.md`](../tools/vault.md)

---

## Marketplace & Extensions

### "What can I install?"
```bash
sulla extensions/list_extension_catalog '{}'
sulla extensions/list_extension_catalog '{"category":"crm"}'
sulla extensions/list_extension_catalog '{"query":"pdf"}'
```

### "What do I have installed?"
```bash
sulla extensions/list_installed_extensions '{}'
```

### "Install Twenty CRM" / "Install X"
```bash
sulla extensions/install_extension '{"id":"docker.io/merchantprotocol/twenty:2.1.0"}'
```

### "Uninstall X"
```bash
sulla extensions/uninstall_extension '{"id":"...","deleteData":false}'
```
**Always confirm before passing `deleteData:true`** — irreversible.

### "Open Twenty CRM"
After locating its URL via `list_installed_extensions`:
```bash
sulla browser/tab '{"action":"upsert","url":"http://localhost:30207"}'
```

### "Is Twenty CRM running?" / "Start it" / "Stop it"
```bash
sulla extensions/get_extension_status '{"id":"docker.io/.../twenty:2.1.0"}'
sulla extensions/start_extension '{"id":"docker.io/.../twenty:2.1.0"}'
sulla extensions/stop_extension '{"id":"docker.io/.../twenty:2.1.0","confirm":true}'   # confirm:true required
```
Stopping kills the container stack and breaks dependent flows; data on disk is preserved.

See: [`marketplace/overview.md`](../marketplace/overview.md)

---

## Marketplace artifacts (5 kinds: skill / function / workflow / agent / recipe)

The generic `marketplace/*` tools work for all 5 artifact kinds. See [`tools/marketplace.md`](../tools/marketplace.md).

### "Search the marketplace"
```bash
sulla marketplace/search '{"kind":"function","query":"pdf"}'
sulla marketplace/search '{"category":"crm"}'
sulla marketplace/search '{}'                                              # everything
```

### "Tell me about X"
```bash
sulla marketplace/info '{"kind":"function","slug":"pdf-extract-text"}'
```

### "Install / download X"
```bash
sulla marketplace/download '{"kind":"function","slug":"pdf-extract-text"}'
```
For recipes specifically, prefer `extensions/install_extension` — it handles compose lifecycle.

### "Build me a new function / skill / workflow / agent / recipe"
```bash
sulla marketplace/scaffold '{"kind":"function","slug":"my-tool","runtime":"python"}'
sulla marketplace/scaffold '{"kind":"skill","slug":"my-skill"}'
sulla marketplace/scaffold '{"kind":"workflow","slug":"my-routine"}'
sulla marketplace/scaffold '{"kind":"agent","slug":"my-agent"}'
sulla marketplace/scaffold '{"kind":"recipe","slug":"my-recipe"}'
```
Generates the dir + manifest + handler skeleton.

### "Validate this before I publish"
```bash
sulla marketplace/validate '{"kind":"function","slug":"my-tool"}'
```

### "Publish my function to the marketplace"
```bash
sulla marketplace/publish '{"kind":"function","slug":"my-tool","version":"1.0.0"}'
```
Requires Sulla Cloud token in vault under `sulla-cloud/api_token`.

### "Take down my published artifact"
```bash
sulla marketplace/unpublish '{"kind":"function","slug":"my-tool","confirm":true}'
```

### "What artifacts do I have installed?"
```bash
sulla marketplace/list_local '{}'
sulla marketplace/list_local '{"kind":"function"}'
```

### "What have I published?"
```bash
sulla marketplace/list_published '{}'
```

### "Update X to the latest version"
```bash
sulla marketplace/update '{"kind":"function","slug":"pdf-extract-text"}'
```

---

## Calendar

### "What's on my calendar today / this week?"
```bash
sulla calendar/calendar_list_upcoming '{"days":7}'
```

### "Schedule a meeting with X tomorrow at 2pm"
Compute the ISO time first (use the user's TZ), then:
```bash
sulla calendar/calendar_create '{"title":"...","start":"2026-04-24T14:00:00-07:00","end":"...","people":["x@y.com"]}'
```

### "Remind me to do X tomorrow at 9am"
Same tool — reminders aren't separate. Use a short event. SchedulerService surfaces it when start_time arrives.

### "Cancel that meeting"
```bash
sulla calendar/calendar_cancel '{"eventId":123}'
```

See: [`tools/calendar.md`](../tools/calendar.md)

---

## Notifications

### "Notify me when X is done"
Track the long-running task. When complete, check presence:
```bash
sulla bridge/get_human_presence '{}'
```
If `idleMinutes > 2`, fire:
```bash
sulla notify/notify_user '{"title":"...","message":"..."}'
```
If user is here, just respond in chat.

### "Let me know if anything fails overnight"
Set up a workflow with a `schedule` trigger that monitors the thing you care about + a `desktop-notification` node on the failure path. Don't rely on the heartbeat.

See: [`tools/notify.md`](../tools/notify.md)

---

## Heartbeat

### "What's the heartbeat doing?"
Read `HeartbeatService.getStatus()` and `getHistory(20)`. Summarize: enabled? last fire? last summary?

### "Pause / resume the heartbeat"
Toggle `SullaSettingsModel.set('heartbeatEnabled', true|false)`.

### "Make it check every 10 minutes"
`SullaSettingsModel.set('heartbeatDelayMinutes', 10)`.

See: [`environment/heartbeat.md`](../environment/heartbeat.md)

---

## Docker / Containers / Services

### "What's running?"
```bash
sulla docker/docker_ps '{}'
```

### "Logs from container X"
```bash
sulla docker/docker_logs '{"container":"X","tail":200}'
```

### "Restart Postgres / Redis / a runtime"
**Don't.** These are managed by ServiceLifecycleManager, not docker tools. Tell the user; the fix is usually restarting the Desktop app.

### "Restart my Twenty CRM container"
That's an extension. Avoid `docker_stop` on it without confirmation — user data lives there. Prefer the extensions API or get explicit approval first.

### "Build me a container"
```bash
sulla docker/docker_build '{"path":"/Users/.../app","tag":"app:dev"}'
```

See: [`environment/docker.md`](../environment/docker.md)

---

## Browser

The agent's most-used tool category. **Two paradigms:** handle-based (preferred — `snapshot` returns `@btn-submit` style handles) and coordinate-based (fallback — `screenshot` shows pixel coords for `click_at`/`type_at`).

### "Open this URL"
```bash
sulla browser/tab '{"action":"upsert","url":"https://..."}'
```
Response includes a dehydrated DOM snapshot inline — no separate `snapshot` call needed.

### "Close that tab"
```bash
sulla browser/tab '{"action":"remove","assetId":"..."}'
```

### "Show me what's on this page" / "Read the page"
```bash
sulla browser/snapshot '{"assetId":"..."}'      # ~5k-token DOM tree with handles
sulla browser/text '{"assetId":"..."}'          # reader-mode text only
```

### "Take a screenshot"
```bash
sulla browser/screenshot '{"assetId":"..."}'    # saves to ~/sulla/artifacts/screenshots/
```
**Returns `{path, width, height, ...}` not base64.** Load the path with `Read` for vision context. `grid:true` (default) overlays a coordinate grid for `click_at` planning.

### "Click X on the page"
1. `browser/snapshot` — find the handle (e.g., `@btn-submit`)
2. `browser/click '{"assetId":"...","handle":"@btn-submit"}'`

If no handle (shadow DOM, canvas, etc.):
1. `browser/screenshot` with grid
2. `browser/click_at '{"assetId":"...","x":420,"y":380}'`

### "Fill out the form"
```bash
sulla browser/form '{"assetId":"..."}'                                       # see current values
sulla browser/snapshot '{"assetId":"..."}'                                   # find field handles
sulla browser/fill '{"assetId":"...","handle":"@field-email","value":"x@y.com"}'
sulla browser/fill '{"assetId":"...","handle":"@field-pw","value":"...","submit":true}'
```

### "Type into this chat widget" (custom JS, no normal handle)
```bash
sulla browser/screenshot '{"assetId":"...","grid":true}'      # find the input pixel coords
sulla browser/type_at '{"assetId":"...","x":300,"y":600,"text":"hello","submit":true}'
```

### "Wait for X to appear before continuing"
```bash
sulla browser/wait '{"assetId":"...","selector":".loaded","timeout":8000}'
```

### "Run some JavaScript on this page"
```bash
sulla browser/eval_js '{"assetId":"...","code":"return document.title"}'
```
Returns result + console logs + DOM mutation count + navigation detection.

### "Get / set / delete a cookie"
```bash
sulla browser/manage_cookies '{"action":"getAll","assetId":"..."}'
sulla browser/manage_cookies '{"action":"set","assetId":"...","name":"k","value":"v","domain":".x.com"}'
```

### "Browse this in the background without disturbing what I'm looking at"
```bash
sulla browser/background_browse '{"action":"open","url":"https://...","waitMs":3000}'
```

### "Remind me to check the deploy in 5 minutes"
```bash
sulla browser/schedule_alarm '{"action":"create","name":"deploy-check","delayInMinutes":5}'
```
**Doesn't survive app restart** — for durable scheduling use `calendar/calendar_create`.

### "Search what we talked about before"
```bash
sulla browser/search_conversations '{"action":"search","query":"workflow X","type":"chat"}'
```

See: [`tools/browser.md`](../tools/browser.md)

---

## AppleScript & Computer Use

### "Add this to my macOS Calendar / Reminders / Notes"
```bash
sulla applescript/applescript_execute '{
  "target_app":"Calendar","action_type":"write",
  "script":"tell application \"Calendar\" to ..."
}'
```
**Caveat:** the user must have enabled the target app in **Computer Use Settings** AND granted macOS Automation permission. If denied, tell them where to fix it.

**Sulla's calendar vs macOS Calendar:** `sulla calendar/*` writes to Sulla's DB and routes via the scheduler. AppleScript writes to macOS Calendar (which then syncs via iCloud / Google). Confirm intent.

### "What song is playing?" / "Pause Music"
```bash
sulla applescript/applescript_execute '{
  "target_app":"Music","action_type":"read",
  "script":"tell application \"Music\" to if player state is playing then return name of current track & \" — \" & artist of current track"
}'
```

### "Send an email via Mail"
Compose with `visible:true` so the user clicks Send themselves — don't auto-send unless they explicitly said so.

### "Open this file in Finder"
```bash
sulla applescript/applescript_execute '{
  "target_app":"Finder","action_type":"write",
  "script":"tell application \"Finder\" to open POSIX file \"/path/to/file\""
}'
```

### "Toggle Dark Mode" / control System Settings
Use `target_app: "System Events"`. Confirm before changing system-level settings.

### "Can you control my Mac?"
Be honest: **AppleScript-mediated app control YES** (Calendar/Mail/Reminders/Notes/Finder/Music/Slack/etc., user must enable per-app). **Pixel-level mouse/keyboard control across the desktop NOT YET** — that's a planned feature.

### "Take a screenshot of my whole screen"
**Not shipped today.** Browser-internal screenshots work (`browser/screenshot`). Full-desktop screenshot needs the Phase 1 grid overlay + native screencapture, which isn't built. Tell the user honestly and ask them to take it manually if needed.

### "Click somewhere on my desktop / in another app"
**Not shipped.** This is the planned full computer-use capability. Workaround: if the target is in an app with AppleScript / System Events UI scripting, that may work — but it's risky and brittle. Better to wait for Phase 2.

See: [`tools/applescript.md`](../tools/applescript.md), [`tools/computer-use.md`](../tools/computer-use.md)

---

## GitHub

### "Push my changes"
```bash
sulla github/git_status '{}'        # see what changed
sulla github/git_add '{"paths":[...]}'
sulla github/git_commit '{"message":"..."}'
sulla github/git_push '{}'
```

### "Open a PR"
```bash
sulla github/github_create_pr '{"title":"...","body":"...","base":"main","head":"my-branch"}'
```

### "Create an issue"
```bash
sulla github/github_create_issue '{"repo":"owner/name","title":"...","body":"..."}'
```

See: [`tools/github.md`](../tools/github.md)

---

## Sulla Cloud

### "What's Sulla Cloud?"
Recite from `cloud/overview.md`. Lead with: Desktop is free and open-source; Cloud is the managed/paid tier with hosted compute, hosted models, mobile pairing, and 24/7 agent runs.

### "How much does Cloud cost?"
$19/mo Premium Support (aspirational, not yet marketed); $99/mo Enterprise Gateway (pilot). **Don't invent other tiers.**

### "Sign me up for Cloud"
The agent can't provision accounts. Direct them to the SullaCloudCard in Settings (sign-in flow). Billing is out-of-band (Jonathon).

See: [`cloud/overview.md`](../cloud/overview.md)

---

## Memory / Identity

### "Remember that I prefer X"
```bash
sulla meta/add_observational_memory '{"priority":"high","content":"..."}'
```

### "Forget that"
Find the memory id (in the system prompt's memory list), then:
```bash
sulla meta/remove_observational_memory '{"id":"..."}'
```

### "What do you know about me?"
Read `~/sulla/identity/human/identity.md` and surface the user's recent observational memories.

---

## Inter-Agent

### "Tell the workbench agent to..."
Wrap the message in a channel tag (no tool call needed):
```
<channel:workbench>Please update the status for task #42.</channel:workbench>
```
Fire-and-forget. Don't poll for a reply.

### "What other agents are running?"
Check the system prompt (always lists active agents and their status). Don't query — that data is already there.

---

---

## UI Navigation (open windows / tabs in the app)

The agent **CAN** open Sulla Desktop's built-in views via [`sulla ui/open_tab`](../tools/ui.md). Modes: `marketplace`, `vault`, `integrations`, `routines`, `history`, `secretary`, `chat`, `document`, `browser`, `welcome`.

### "Open the marketplace"
```bash
sulla ui/open_tab '{"mode":"marketplace"}'
```

### "Show me my workflows / open Routines"
```bash
sulla ui/open_tab '{"mode":"routines"}'
```
*Note: no per-routine deep-link yet — opens the index. Tell the user the name to look for.*

### "Open my vault / integrations / history"
```bash
sulla ui/open_tab '{"mode":"vault"}'
sulla ui/open_tab '{"mode":"integrations"}'
sulla ui/open_tab '{"mode":"history"}'
```

### "Open settings"
Settings is a separate window, not a tab mode — no agent tool yet. Direct the user to click.

### "Take notes for this meeting" / "Open Secretary Mode"
```bash
sulla ui/open_tab '{"mode":"secretary"}'
```

### "Open Twenty CRM" (or any extension web UI)
Extension UIs are external URLs — use `browser/tab`:
```bash
sulla extensions/list_installed_extensions '{}'   # find the URL
sulla browser/tab '{"action":"upsert","url":"http://localhost:30207"}'
```

### "Manage things in the marketplace" / "Find me X in the marketplace"
The list / search / install / uninstall parts already work via the extensions API:
```bash
sulla extensions/list_extension_catalog '{"query":"X"}'
sulla extensions/install_extension '{"id":"..."}'
```
And now you can also pop the visual marketplace tab if helpful:
```bash
sulla ui/open_tab '{"mode":"marketplace"}'
```

---

## Capture Studio

The agent has **13 headless `capture/*` tools** (teleprompter, mic, speaker loopback, screenshots) that work without the user opening the Capture Studio window. Multi-source recording (the actual MediaRecorder session) is still user-driven. See [`tools/capture.md`](../tools/capture.md).

### "Take a screenshot of my screen"
```bash
sulla capture/screenshot '{}'                                              # primary display
```
Then read the returned path with `meta/read_file` for vision input.

### "Take a screenshot of just <window>"
```bash
sulla capture/list_screens '{"kind":"window"}'                             # find the window id
sulla capture/screenshot '{"sourceId":"window:1234:0"}'
```

### "Read this script aloud with the teleprompter"
```bash
sulla capture/teleprompter_script '{"text":"Welcome everyone, today we'\''ll cover..."}'
sulla capture/teleprompter_style '{"fontSize":56}'                         # tune appearance
sulla capture/teleprompter_close                                           # done
```

### "Listen to my mic for the next minute"
```bash
sulla capture/mic_start '{"formats":["pcm-s16le"]}'
# ...do work...
sulla capture/mic_stop
```
Always pair start with stop — the device hold is ref-counted and leaks pin the mic.

### "Capture system audio"
```bash
sulla capture/speaker_start
sulla capture/audio_state                                                  # confirm device
sulla capture/speaker_stop
```

### "Is anything capturing audio right now?"
```bash
sulla capture/audio_state
```

### "Record this meeting / start a multi-source recording"
**Still user-driven** — the renderer-side MediaRecorder isn't agent-controllable yet. Tell the user to open Capture Studio (menu / shortcut), pick sources, hit record.

### "Where are my recordings?"
`~/sulla/captures/<sessionId>/` for sessions, `~/sulla/captures/screenshots/YYYY-MM-DD/` for one-off screenshots. List with `meta/exec` and inspect `manifest.json`.

### "Transcribe this old recording"
No built-in tool. Workaround: write a custom function that runs Whisper.cpp against the file.

### "Why is system audio not capturing?"
Known: BlackHole is broken on macOS 15. Mic still works. Tell the user honestly.

---

## Secretary Mode

Secretary Mode is **shipped** and agent-controllable. See `desktop/secretary-mode.md`.

### "Take notes for this meeting" / "Start secretary mode"
```bash
sulla secretary/start '{}'
```
Opens (or focuses) a Secretary tab and auto-starts the listening session — no user click required. Idempotent: if already listening, returns "already listening". The user must have previously granted microphone permission; if not, the OS prompt appears on first run.

Fallback (if the agent window isn't up): tell the user `Cmd+Shift+S` (macOS) or `Ctrl+Shift+S` (Windows), or the tray menu.

### "Stop taking notes" / "End secretary mode"
```bash
sulla secretary/stop '{}'
```
No-op if no session is active.

### "Is secretary mode running?"
```bash
sulla secretary/status '{}'
```
Returns `{"listening":boolean,"tabId":string|null}`. Use before start/stop if you need to condition on current state.

### "Hey Sulla" (during a meeting)
The wake word is detected by SecretaryModeController automatically. The agent receives the prompt with `inputSource: 'secretary-wake'` — just respond as you would to any chat.

### "What were the action items from earlier?"
The agent has no structured retrieval tool for past meeting analyses. Look in chat history. (Gap.)

### "Does this work when my laptop is closed?"
Not yet. That's the Cloud-routed Phase 2.

---

## Sulla Mobile

The Desktop agent can **talk about** Sulla Mobile but can't manage it remotely. See `mobile/overview.md`.

### "What is Sulla Mobile?"
AI iPhone receptionist + Desktop companion. Customers call your Twilio number, the AI answers, you see it live on your phone. Plus push-to-talk to your Desktop AI from anywhere.

### "How do I pair my phone?"
Sign in on both Desktop and Mobile with the same account. No QR code yet — that's Phase 2.

### "Show me my last call from the phone"
No tool wraps the mobile API from Desktop. Direct the user to the Recents tab on their phone.

### "Send something to my phone"
No file/data transfer mechanism between Desktop and Mobile. Gap.

### "How much does the receptionist cost?"
$49.99/mo Starter (100 min) or $99.99/mo Pro (250 min) — Apple IAP. **Don't conflate with Sulla Cloud** ($99/mo Enterprise Gateway is a different product.)

---

## Kubernetes (k3s)

The agent has direct kubectl + rdctl access. **No safety rails — be disciplined.** See `environment/kubernetes.md`.

### "What's running in my cluster?"
```bash
sulla rdctl/rdctl_shell '{"command":"kubectl get pods -A"}'
```

### "Show me logs from pod X"
```bash
sulla rdctl/rdctl_shell '{"command":"kubectl logs -n <ns> <pod> --tail=200"}'
```

### "Deploy this manifest"
**Always offer dry-run first:**
```bash
sulla kubectl/kubectl_apply '{"file":"...","dryRun":"server"}'
```
Show the diff, confirm with user, then live apply.

### "Why is my service broken?"
```bash
sulla kubectl/kubectl_describe '{"resource":"service","name":"X","namespace":"default"}'
```

### "Delete this pod"
Confirm first. **Never** use `force:true` or `gracePeriod:0` without explicit user approval.

### "Reset Kubernetes"
`rdctl_reset` wipes the cluster. **Treat as destructive — triple-confirm.**

### Hard rule
Never touch `kube-system`, `kube-public`, `kube-node-lease`, or Sulla-managed namespaces (cert-manager, spinkube, traefik) without explicit, repeated user confirmation. You will break the desktop app.

---

## When the request doesn't fit any of the above

1. Identify which **subsystem** it touches (workflow? function? vault? browser? etc.)
2. Skim that subsystem's doc in `sulla-docs/`
3. **Check `agent-patterns/known-gaps.md`** — the request may have no tool yet
4. Use `sulla meta/browse_tools '{"query":"..."}'` to discover unfamiliar tools
5. **Verify the tool exists** before calling — don't hallucinate
6. If you genuinely have no path: ask one clarifying question or tell the user it's not supported. Don't fake it.
