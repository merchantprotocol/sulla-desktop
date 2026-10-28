# User Stories — Request → Action Playbook

Common user requests and how the agent should handle them. Each has the plan and the tool calls. Read this when a request maps cleanly to a category. Don't reinvent the plan from scratch every time.

CLI names below come from the live catalog (`sulla meta/browse_tools`). If a name here fails, browse the category and use what it says.

If the request is ambiguous, ask one clarifying question, then act. Don't write a wall of plan or batch questions.

---

## Workflows

### "Build me a workflow that does X"
**Plan:**
1. Pin down the trigger, the steps, and the failure mode. Ask only if one of them is genuinely unclear. Otherwise draft it.
2. Read `workflows/authoring.md`, `workflows/schema.md`, and `workflows/node-types.md` in sulla-docs.
3. Draft the YAML.
4. Validate: `sulla meta/validate_sulla_workflow '{"yaml":"<yaml>"}'` (or `'{"filePath":"<path>"}'` for a file). Fix every error and run it again.
5. Register it as a draft: `sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<yaml>","status":"draft"}'`. Pass `status` yourself. The default is `production`.
6. Dry-run it: `sulla meta/dry_run_workflow '{"slug":"<slug>"}'`. This walks the graph and runs nothing.
7. Run it: `sulla meta/execute_workflow '{"workflowId":"<slug>"}'`. This only works for slugs that appear verbatim in the "Available workflows" section of your system prompt. If yours isn't listed, say so. Don't guess.
8. Promote it when it's ready: `sulla workflow/set_workflow_status '{"name":"<name>","status":"production"}'`. Validation has to pass first. See [`validation.md`](validation.md).

See: [`workflows/authoring.md`](../workflows/authoring.md)

### "Validate this workflow"
```bash
sulla meta/validate_sulla_workflow '{"filePath":"..."}'
```
Returns a list of issues with severity and a `path`. Surface the errors with their path so the user can fix them.

### "Why did my workflow fail?" / "Debug my workflow"
**Plan:**
1. Get the `executionId`. Use "How did workflow X run" below to list recent runs.
2. Get the checkpoint trail: `sulla meta/restart_from_checkpoint '{"executionId":"<id>"}'`.
3. The failed node is the one after the last checkpoint. (Unverified: confirm this against a real failed run before you rely on it.)
4. Grep the log for the run: `grep "<executionId>" ~/sulla/logs/playbook-debug.log`.

### "How did workflow X run today?" / "Show me the history"
```bash
sulla meta/restart_from_checkpoint '{"workflowId":"X"}'                  # recent runs
sulla meta/restart_from_checkpoint '{"executionId":"wfp-..."}'           # checkpoints for one run
sulla workflow/routine_report '{"slug":"X","last_k":10}'                 # per-routine report
```

### "Restart workflow X from where it failed"
```bash
sulla meta/restart_from_checkpoint '{"workflowId":"X"}'                  # list runs
sulla meta/restart_from_checkpoint '{"executionId":"wfp-..."}'           # list checkpoints
sulla meta/restart_from_checkpoint '{"executionId":"wfp-...","nodeId":"failed-node"}'
```

### "Schedule workflow X to run daily at 9am"
Add a `schedule` trigger node to the workflow definition. Set the frequency, hour, minute, and timezone. Then set the status to `production`:
```bash
sulla workflow/set_workflow_status '{"name":"X","status":"production"}'
```
The status change re-arms the scheduler and reports the cron state. (Unverified: the exact schedule trigger field names. Check `workflows/node-types.md`.)

### "Run workflow X now"
```bash
sulla meta/execute_workflow '{"workflowId":"X","message":"optional payload"}'
```
Only for slugs listed under "Available workflows". Returns the `executionId`. The run is async. Watch the playbook log.

### "List my workflows"
No flat list tool. Query the table:
```bash
sulla pg/query '{"sql":"SELECT name, status FROM workflows ORDER BY status, name"}'
```
`status` is `draft`, `production`, or `archive`.

### "What's scheduled to run?"
No tool lists the registered cron jobs directly. `sulla workflow/set_workflow_status` reports the armed cron state for one workflow. `sulla workflow/refresh_schedules` re-arms the schedules.

### "Stop / cancel a running workflow"
```bash
sulla meta/stop_workflow '{"executionId":"<id>","reason":"why"}'
```
The stop is cooperative. The workflow halts at its next step. If it's waiting on a long LLM or sub-agent call, it stops when that call returns. To pause and resume instead:
```bash
sulla meta/pause_workflow '{"executionId":"<id>"}'
sulla meta/resume_workflow '{"executionId":"<id>"}'
```
A hard kill means restarting Sulla Desktop. Warn the user before you suggest that.

### "Archive / delete workflow X"
```bash
sulla workflow/set_workflow_status '{"name":"X","status":"archive"}'
```
Archive keeps the history. Hard delete is not a tool. If the user wants the row gone, that's a `pg/execute` change, so confirm first.

---

## Functions

### "Build me a custom function that does X"
**Plan:**
1. Confirm what it takes in, what it returns, and which runtime (python, node, or shell).
2. Scaffold it: `sulla marketplace/scaffold '{"kind":"function","slug":"<slug>","runtime":"python"}'`.
3. Fill in `function.yaml` per `functions/schema.md` and the handler per `functions/runtimes.md`. The signature must match.
4. Add `requirements.txt`, `package.json`, or `packages.txt` if there are dependencies.
5. Validate: `sulla marketplace/validate '{"kind":"function","slug":"<slug>"}'`.
6. Test: `sulla function/run '{"slug":"<slug>","inputs":{...}}'`.

See: [`functions/authoring.md`](../functions/authoring.md)

### "Run my function X"
```bash
sulla function/run '{"slug":"X","inputs":{...}}'
```

### "What functions do I have?"
```bash
sulla function/list '{}'
```

### "Why did my function fail?"
```bash
sulla function/runs '{"slug":"X","only_failures":true,"verbose":true}'
```
Each run records the error stage and the error. Then:
1. `function/list` confirms the function still parses.
2. `function/run` with the same inputs gives you the full trace.
3. Check the handler's signature and return shape against `spec.outputs`.

### "Show me the source of function X"
Read `~/sulla/functions/X/function.yaml` and the handler file. There's no dedicated tool. It's just files.

### "Edit function X"
Edit the files in place. Bump the `version` field in `function.yaml`. Or pass an explicit `version` to `function/run`. (Unverified: that a version bump is what makes the runtime reload.)

### "Delete function X"
`rm -rf ~/sulla/functions/X`. This destroys data, so confirm with the user first. Check for a `.git` directory in it before you delete.

---

## Vault & Credentials

### "Connect my GitHub / Slack / etc."
The agent doesn't run OAuth. Send the user to Settings → Integrations → the service → Connect. (Unverified: the exact menu path.) After they confirm, check it:
```bash
sulla vault/is_enabled '{"account_type":"github"}'
```

For a raw API key with no OAuth, store it with `vault/set_credential`:
```bash
sulla vault/set_credential '{"account_type":"<type>","property":"api_key","value":"..."}'
```

### "What integrations do I have connected?"
```bash
sulla vault/list_accounts '{"account_type":"X"}'
```
Or answer from what the user has already told you, and spot-check one.

### "Use my GitHub PAT to call the API"
**Don't read the secret.** Use the proxy pattern. Vault injects the credential:
```bash
sulla <account_id>/github '{"method":"GET","path":"/user/repos"}'
```
Get `<account_id>` from `vault/list_accounts`. (Unverified: the `github` slug in the proxy path.)

### "Show me my OpenAI key"
**Don't print it.** Never put an API key, token, or password in chat. Tell the user the key is stored in Settings → Vault, and offer to use it through the proxy pattern above. If they want to see it, they should read it in Settings themselves.

### "Autofill my password on this site"
```bash
sulla vault/autofill '{"origin":"https://github.com"}'
```
The password goes into the active tab. It never comes back to the agent.

### "Save my password for this site"
```bash
sulla vault/set_credential '{"account_type":"website","property":"password","value":"...","account_id":"github.com"}'
```
The user has to give you the value. Don't generate one and save it without telling them.

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

### "Install X"
Find the id in the catalog, then:
```bash
sulla extensions/install_extension '{"id":"<id from the catalog>"}'
```

### "Uninstall X"
```bash
sulla extensions/uninstall_extension '{"id":"...","deleteData":false}'
```
**Confirm before `deleteData:true`.** It destroys the data, and that can't be undone.

### "Open an extension's web UI"
After you find its URL with `list_installed_extensions`:
```bash
sulla browser/tab '{"action":"upsert","url":"http://localhost:<port>"}'
```

### "Is X running?" / "Start it" / "Stop it"
```bash
sulla extensions/get_extension_status '{"id":"<id>"}'
sulla extensions/start_extension '{"id":"<id>"}'
sulla extensions/stop_extension '{"id":"<id>","confirm":true}'
```
`confirm:true` is required to stop. Stopping kills the container stack and breaks anything that depends on it. The data on disk stays.

See: [`marketplace/overview.md`](../marketplace/overview.md)

---

## Marketplace artifacts (skill / function / routine / recipe / integration)

The `marketplace/*` tools cover skills, functions, workflows, agents, recipes, and integrations. Workflows use the internal `routine` API key. See [`tools/marketplace.md`](../tools/marketplace.md).

### "Search the marketplace"
```bash
sulla marketplace/search '{"kind":"function","query":"pdf"}'
sulla marketplace/search '{"category":"crm"}'
sulla marketplace/search '{}'
```

### "Tell me about X"
```bash
sulla marketplace/info '{"kind":"function","slug":"pdf-extract-text"}'
```

### "Install / download X"
```bash
sulla marketplace/download '{"kind":"function","slug":"pdf-extract-text"}'
```
For recipes, use `extensions/install_extension`. It handles the compose lifecycle.

### "Build me a new function / skill / workflow / agent / recipe"
```bash
sulla marketplace/scaffold '{"kind":"function","slug":"my-tool","runtime":"python"}'
sulla marketplace/scaffold '{"kind":"skill","slug":"my-skill"}'
sulla marketplace/scaffold '{"kind":"workflow","slug":"my-routine"}'
sulla marketplace/scaffold '{"kind":"agent","slug":"my-agent"}'
sulla marketplace/scaffold '{"kind":"recipe","slug":"my-recipe"}'
```
This makes the directory, the manifest, and a handler skeleton.

### "Validate this before I publish"
```bash
sulla marketplace/validate '{"kind":"function","slug":"my-tool"}'
```

### "Publish my function to the marketplace"
```bash
sulla marketplace/publish '{"kind":"function","slug":"my-tool","version":"1.0.0"}'
```
This needs a Sulla Cloud sign-in in the app. The submission stays pending until an admin approves it. Once approved, it's public. Validate first.

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

### "What's different from the marketplace version?"
```bash
sulla marketplace/diff '{"kind":"function","slug":"pdf-extract-text"}'
```

---

## Calendar

### "What's on my calendar today / this week?"
```bash
sulla calendar/list_upcoming '{"days":7}'
```

### "Schedule a meeting with X tomorrow at 2pm"
Work out the ISO time in the user's timezone first. Then:
```bash
sulla calendar/create '{"title":"...","start":"2026-04-24T14:00:00-07:00","end":"...","people":["x@y.com"]}'
```
This creates the event in Sulla's calendar. It doesn't send an invite. Sending an invite to someone outside is a message in the user's name, so ask first.

### "Remind me to do X tomorrow at 9am"
Same tool. Reminders aren't a separate thing. Make a short event. (Unverified: how the scheduler surfaces it at the start time.)

### "Cancel that meeting"
```bash
sulla calendar/cancel '{"eventId":123}'
```

See: [`tools/calendar.md`](../tools/calendar.md)

---

## Notifications

### "Notify me when X is done"
Track the long-running task. When it finishes, check whether the user is around:
```bash
sulla bridge/get_human_presence '{}'
```
It returns a text summary with status, idle time, view, and activity. If he's away, or idle for more than a couple of minutes, send a notification:
```bash
sulla notify/user '{"title":"...","message":"..."}'
```
If he's here, just answer in chat.

### "Let me know if anything fails overnight"
Build a workflow with a `schedule` trigger that checks what you care about. Put a `desktop-notification` node on the failure path. Don't rely on the heartbeat for this.

### "Notify my phone too"
```bash
sulla notify/user '{"title":"...","message":"...","targets":["desktop","mobile"]}'
```
The mobile leg posts to the sulla-workers `/push/{user_id}` route. (Unverified: that the backend route is deployed.)

### "Show me notifications that failed"
```bash
sulla notify/history '{"only_failures":true}'
```

See: [`tools/notify.md`](../tools/notify.md)

---

## Heartbeat

The heartbeat is the autonomous background loop. It's off by default. Control it through settings. Don't write Redis directly.

### "What's the heartbeat doing?"
```bash
sulla settings/get '{"property":"heartbeatEnabled"}'
sulla settings/get '{"property":"heartbeatDelayMinutes"}'
```

### "Pause / resume the heartbeat"
```bash
sulla settings/set '{"property":"heartbeatEnabled","value":"false","cast":"boolean"}'
sulla settings/set '{"property":"heartbeatEnabled","value":"true","cast":"boolean"}'
```

### "Make it check every 10 minutes"
```bash
sulla settings/set '{"property":"heartbeatDelayMinutes","value":"10","cast":"number"}'
```

### "Only run during working hours"
Set `heartbeatWindow` to a JSON object with `days`, `startHour`, `endHour`, and `tz`. Use `cast:"json"`. Example: weekdays, 9 to 17, Pacific time.
```bash
sulla settings/set '{"property":"heartbeatWindow","value":"{\"days\":[1,2,3,4,5],\"startHour\":9,\"endHour\":17,\"tz\":\"America/Los_Angeles\"}","cast":"json"}'
```
(Unverified: the day numbering, and how the window handles a start hour later than the end hour.)

See: [`environment/heartbeat.md`](../environment/heartbeat.md)

---

## Docker / Containers / Services

### "What's running?"
```bash
sulla docker/ps '{}'
```

### "Logs from container X"
```bash
sulla docker/logs '{"container":"X","tail":200}'
```

### "Restart Postgres / Redis / a runtime"
**Don't.** These belong to ServiceLifecycleManager, not to the docker tools. Tell the user. The fix is usually restarting the Desktop app.

### "Restart my Twenty CRM container" (or any extension container)
That's an extension. User data lives in it. Use the extensions API. Don't `docker/stop` it unless the user asks you to.

### "Build me a container"
```bash
sulla docker/build '{"path":"/Users/.../app","tag":"app:dev"}'
```

See: [`environment/docker.md`](../environment/docker.md)

---

## Browser

The agent's most-used tool category. Two paradigms. Handle-based is preferred: `snapshot` returns handles like `@btn-submit`. Coordinate-based is the fallback: `screenshot` shows pixel coordinates for `click_at` and `type_at`.

### "Open this URL"
```bash
sulla browser/tab '{"action":"upsert","url":"https://..."}'
```
The response includes the page snapshot. You don't need a separate `snapshot` call.

### "Close that tab"
```bash
sulla browser/tab '{"action":"remove","assetId":"..."}'
```

### "Show me what's on this page" / "Read the page"
```bash
sulla browser/snapshot '{"assetId":"..."}'      # DOM tree with handles
sulla browser/text '{"assetId":"..."}'          # reader-mode text only
```

### "Take a screenshot of the page"
```bash
sulla browser/screenshot '{"assetId":"..."}'
```
It saves to `~/sulla/artifacts/screenshots/`. The response is text: the file path, the size, and the byte count. It isn't base64. Use `read_file` on the path to load the image for vision. `grid:true` overlays a coordinate grid for `click_at` planning.

### "Click X on the page"
1. `browser/snapshot` to find the handle, such as `@btn-submit`.
2. `browser/click '{"assetId":"...","handle":"@btn-submit"}'`

If there's no handle (shadow DOM, canvas, and so on):
1. `browser/screenshot` with the grid.
2. `browser/click_at '{"assetId":"...","x":420,"y":380}'`

### "Fill out the form"
```bash
sulla browser/form '{"assetId":"..."}'                                       # current values
sulla browser/snapshot '{"assetId":"..."}'                                   # field handles
sulla browser/fill '{"assetId":"...","handle":"@field-email","value":"x@y.com"}'
sulla browser/fill '{"assetId":"...","handle":"@field-pw","value":"...","submit":true}'
```
Submitting a form sends data to a third party. Confirm the values with the user first if they weren't given to you explicitly.

### "Type into this chat widget" (custom JS, no normal handle)
```bash
sulla browser/screenshot '{"assetId":"...","grid":true}'      # find the input's pixel coordinates
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
(Unverified: whether the alarm survives an app restart.) For a reminder that has to last, use `calendar/create`.

### "Search what we talked about before"
```bash
sulla browser/search_conversations '{"action":"search","query":"workflow X","type":"chat"}'
```

See: [`tools/browser.md`](../tools/browser.md)

---

## AppleScript & Computer Use

### "Add this to my macOS Calendar / Reminders / Notes"
```bash
sulla applescript/execute '{
  "target_app":"Calendar","action_type":"write",
  "script":"tell application \"Calendar\" to ..."
}'
```
The app has to be enabled for computer use first (`sulla applescript/computer_use_enable '{"app":"Calendar"}'`). macOS also has to grant Automation permission for it. If permission is denied, tell the user where to fix it.

**Sulla's calendar and macOS Calendar are different.** `sulla calendar/*` writes to Sulla's own database. AppleScript writes to macOS Calendar, which then syncs through iCloud or Google. Make sure the user means the one they're asking for.

### "What song is playing?" / "Pause Music"
```bash
sulla applescript/execute '{
  "target_app":"Music","action_type":"read",
  "script":"tell application \"Music\" to if player state is playing then return name of current track & \" — \" & artist of current track"
}'
```

### "Send an email via Mail"
Compose it with `visible:true` so the user can read it and send it. Only send it yourself if they told you to send it.

### "Open this file in Finder"
```bash
sulla applescript/execute '{
  "target_app":"Finder","action_type":"write",
  "script":"tell application \"Finder\" to open POSIX file \"/path/to/file\""
}'
```

### "Toggle Dark Mode" / change System Settings
Use `target_app: "System Events"`. Confirm before you change a system-level setting. It affects the whole machine.

### "Can you control my Mac?"
Be straight about it. **Yes** to app control through AppleScript for enabled apps. **Yes** to a screenshot of the primary display or a chosen window (`capture/screenshot`). **No** to pixel-level mouse and keyboard control outside the browser. That isn't built yet.

### "Take a screenshot of my whole screen"
```bash
sulla capture/screenshot '{}'                                        # primary display
```
For another display or a single window, list the sources first:
```bash
sulla capture/list_screens '{"kind":"window"}'
sulla capture/screenshot '{"sourceId":"window:1234:0"}'
```

### "Click somewhere on my desktop / in another app"
**Not built.** That's the planned Phase 2 computer use. The closest thing is AppleScript with System Events UI scripting, and that's fragile. Tell the user it isn't supported. Don't fake it.

See: [`tools/applescript.md`](../tools/applescript.md), [`tools/computer-use.md`](../tools/computer-use.md)

---

## GitHub

The git tools take an `absolutePath` to the local checkout. The GitHub tools take `owner` and `repo` as separate fields.

### "Push my changes"
```bash
sulla github/git_status '{"absolutePath":"<repo path>"}'
sulla github/git_add '{"absolutePath":"<repo path>","files":["..."]}'
sulla github/git_commit '{"absolutePath":"<repo path>","message":"..."}'
sulla github/git_push '{"absolutePath":"<repo path>"}'
```
Check `git_status` before you commit, and `git_diff --staged` too. Never commit secrets, `.env` files, or build output.

### "Open a PR"
```bash
sulla github/create_pr '{"owner":"...","repo":"...","title":"...","head":"my-branch","base":"main","body":"...","draft":true}'
```

### "Create an issue"
```bash
sulla github/create_issue '{"owner":"...","repo":"...","title":"...","body":"..."}'
```

### "Show CI status for this branch"
```bash
sulla github/check_runs '{"owner":"...","repo":"...","ref":"<branch>"}'
```

See: [`tools/github.md`](../tools/github.md)

---

## Sulla Cloud

### "What's Sulla Cloud?"
Recite from `cloud/overview.md`. Lead with the point: Desktop is free and open source. Cloud is the managed, paid tier.

### "How much does Cloud cost?"
Quote only what `cloud/overview.md` says. (Unverified: the prices quoted there.) Don't invent other tiers.

### "Sign me up for Cloud"
The agent can't create accounts or handle billing. Send the user to the Sulla Cloud card in Settings, where the sign-in flow is. Billing is the user's own step.

See: [`cloud/overview.md`](../cloud/overview.md)

---

## Memory / Identity

### "Remember that I prefer X"
```bash
sulla observation/add_observational_memory '{"priority":"high","content":"..."}'
```

### "Forget that"
Find the memory id in the system prompt's memory list, then:
```bash
sulla observation/remove_observational_memory '{"id":"..."}'
```
This archives the memory. It doesn't hard-delete it.

### "What do you know about me?"
Read `~/sulla/identity/human/identity.md`. Then surface the user's recent observational memories with `sulla observation/list_observations '{}'`.

---

## Inter-Agent

### "What other agents are running?"
Check the roster in your turn context. It lists the active agents and their status. Don't query for it. If you do need a fresh list, `sulla agents/list_agents '{}'` returns one.

---

## UI Navigation (open windows / tabs in the app)

The agent **can** open Sulla Desktop's built-in views with [`sulla ui/open_tab`](../tools/ui.md). Modes: `marketplace` (also `use-cases` or `packages`), `chat`, `document`, `browser`, `welcome`, `integrations`, `vault`, `routines`, `history`, `secretary`, `agents`, `files`, `decide`. Three modes open separate windows, not tabs: `settings`, `models`, and `audio`.

### "Open the marketplace"
```bash
sulla ui/open_tab '{"mode":"marketplace"}'
```

### "Show me my workflows / open Routines"
```bash
sulla ui/open_tab '{"mode":"routines"}'
```
It opens the index. There's no per-routine deep link. Tell the user what name to look for.

### "Open my vault / integrations / history"
```bash
sulla ui/open_tab '{"mode":"vault"}'
sulla ui/open_tab '{"mode":"integrations"}'
sulla ui/open_tab '{"mode":"history"}'
```

### "Open settings"
```bash
sulla ui/open_tab '{"mode":"settings"}'
```

### "Take notes for this meeting" / "Open Secretary Mode"
```bash
sulla secretary/start '{}'
```
See the Secretary Mode section below. `ui/open_tab` with `"mode":"secretary"` only opens the view.

### "Show me project files"
```bash
sulla ui/open_tab '{"mode":"files"}'
```

### "Open Twenty CRM" (or any extension web UI)
Extension UIs are external URLs. Use `browser/tab`, not `ui/open_tab`. See the Marketplace section.

### "Find me X in the marketplace"
```bash
sulla extensions/list_extension_catalog '{"query":"X"}'
sulla extensions/install_extension '{"id":"..."}'
```
To show the visual marketplace view as well:
```bash
sulla ui/open_tab '{"mode":"marketplace"}'
```

---

## Capture Studio

The agent has 19 `capture/*` tools. They cover screenshots, the microphone, speaker loopback, the teleprompter, screen and camera sources, and a recorder. They work without the user opening the Capture Studio window. See [`tools/capture.md`](../tools/capture.md).

### "Take a screenshot of my screen"
```bash
sulla capture/screenshot '{}'
```
It saves a PNG under `~/sulla/captures/screenshots/YYYY-MM-DD/` and returns the path. Use `read_file` on it for vision input.

### "Take a screenshot of just <window>"
```bash
sulla capture/list_screens '{"kind":"window"}'                           # find the source id
sulla capture/screenshot '{"sourceId":"window:1234:0"}'
```

### "Read this script aloud with the teleprompter"
```bash
sulla capture/teleprompter_script '{"text":"Welcome everyone, today we'\''ll cover..."}'
sulla capture/teleprompter_style '{"fontSize":56}'
sulla capture/teleprompter_close
```

### "Listen to my mic for the next minute"
```bash
sulla capture/mic_start '{"formats":["pcm-s16le"]}'
# ...do work...
sulla capture/mic_stop
```
Always pair a start with a stop. The device hold is ref-counted, and a missed stop leaves the mic pinned.

### "Capture system audio"
```bash
sulla capture/speaker_start
sulla capture/audio_state                                                # confirm the device
sulla capture/speaker_stop
```

### "Is anything capturing audio right now?"
```bash
sulla capture/audio_state
```

### "Record this meeting / start a multi-source recording"
```bash
sulla capture/recorder_start '{"screen":"<sourceId>","camera":"<deviceId>","mic":true,"speaker":true}'
sulla capture/recorder_status
sulla capture/recorder_stop
```
Add a screen or camera while it runs with `capture/screen_set`, `capture/camera_list`, and `capture/camera_set`. All the parameters are optional. Use `recorder_status` to see what is running.

### "Where are my recordings?"
Sessions are under `~/sulla/captures/<sessionId>/`. Check the `manifest.json` in each. (Unverified: the session folder layout.)

### "Transcribe this old recording"
No built-in tool. Write a custom function that runs Whisper.cpp on the file.

### "Why is system audio not capturing?"
Known: BlackHole doesn't work on macOS 15. The mic still works. Tell the user that plainly.

---

## Secretary Mode

Secretary Mode is shipped, and the agent controls it.

### "Take notes for this meeting" / "Start secretary mode"
```bash
sulla secretary/start '{}'
```
This opens or focuses the Secretary tab and starts listening. If a session is already listening, it says so and does nothing. Microphone permission has to be granted. If it isn't, the OS asks on first run. If the agent can't reach the window, tell the user `Cmd+Shift+S` (macOS) or `Ctrl+Shift+S` (Windows), or the tray menu.

### "Stop taking notes" / "End secretary mode"
```bash
sulla secretary/stop '{}'
```
No-op if no session is active.

### "Is secretary mode running?"
```bash
sulla secretary/status '{}'
```
(Unverified: the exact shape of the response.)

### "Hey Sulla" (during a meeting)
The wake word is detected automatically. The prompt arrives with `inputSource: 'secretary-wake'`. Answer it like any other chat message.

### "What were the action items from earlier?"
There's no structured retrieval tool for past meeting analyses. Look in chat history. This is a known gap.

### "Does this work when my laptop is closed?"
Not yet. That's the Cloud-routed Phase 2.

---

## Sulla Mobile

Sulla Mobile is the signed-in companion for Chat, Files, push-to-talk, Passwords, and Settings. Studio pages are available inside Settings.

### "How do I pair my phone?"
Sign in on Desktop and Mobile with the same account. To check whether the phone is reachable:
```bash
sulla mobile/list_devices '{"device_type":"mobile","online_only":true}'
```

### "Send something to my phone"
Use `notify/user` with `targets:["mobile"]`. Check `mobile/list_devices` first when reachability matters.

---

## Projects in Files

Projects live in Sulla Files under `Projects/<project-slug>/`. Each project folder has PROJECT.md (goal, status, owner agent, links) and TASKS.md (a markdown checklist: `- [ ] task — owner — note`; tick `- [x]` when done). Put plans, specs and notes in that folder too. Read and edit them with the Files tools (files_where, files_get, files_put); search projects with Files search. Create a new project folder only when the work is a real multi-session goal and no existing project fits. Never keep a separate task list anywhere else.

## When the request doesn't fit any of the above

1. Work out which subsystem it touches: workflows, functions, vault, browser, and so on.
2. Skim that subsystem's doc in sulla-docs.
3. Check [`known-gaps.md`](known-gaps.md). The request may have no tool yet.
4. Use `sulla meta/browse_tools '{"query":"..."}'` to find tools you don't know.
5. Verify the tool exists before you call it. Don't guess a name.
6. If there's no path, ask one clarifying question or tell the user it isn't supported. Don't fake it.


Projects are plain files. See [Projects in Files](../environment/projects-in-files.md).
