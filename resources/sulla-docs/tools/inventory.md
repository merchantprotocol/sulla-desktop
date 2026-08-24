# Tool Inventory

Master list of every tool the agent can call. **Regenerated from the source manifests (`pkg/rancher-desktop/agent/tools/<category>/manifests.ts`) on 2026-08-23 — 263 tools across 30 categories.** Each line is `sulla <category>/<tool> — purpose`.

> The `rules` category (user-created guardrail rules) and its **Security Conscience** enforcement were **retired 2026-08-19** and are intentionally omitted here. Some `rules/*` tool code may still linger in a given build; treat it as vestigial and don't re-add it to this doc.

**Important routing note:** the backend resolves tools by **name only** — the category segment in the URL is ignored. So `sulla anything/spawn_agent` works the same as `sulla meta/spawn_agent`. But the **canonical** form (what `sulla <cat> --help` lists, and what the manifest's own `category` field says) is what you should use for clarity. Categories and canonical pairings below.

**Source vs. installed drift:** these counts reflect the **source tree** — i.e. what ships in the next build. The `sulla` CLI baked into a *running* install can lag (e.g. an older build exposes only 8 of the current 15 workflow-file tools). When the CLI and this doc disagree, the CLI tells you what *this* install can do today; this doc tells you what the code defines. Reconcile with:
```bash
sulla <category> --help          # what THIS install exposes right now
```
(Requires `SULLA_API_TOKEN` from `~/Library/Application Support/rancher-desktop/chat-api-token.json` + `SULLA_HOST=localhost` when running outside Lima.)

---

## meta — system foundation: exec, discovery, files, questions, workflow control (14 tools)
- `sulla meta/spawn_agent` — Spawn one or more sub-agents to work on tasks independently (canonical category is `meta`, though it lives in the agents folder).
- `sulla meta/exec` — Run any shell command inside the isolated Lima VM with root access — also how you invoke every `sulla <cat>/<tool>` CLI call.
- `sulla meta/exechost` — LAST RESORT host-macOS shell (only when the parent host MUST be used; gated by host access).
- `sulla meta/ask_user_question` — Pause and ask the user multiple-choice question(s); BLOCKS until they answer (5-min default). Use for approvals via Approve/Deny options.
- `sulla meta/file_search` — Fast BM25 keyword search across any directory PLUS the bundled sulla-docs by default (`includeSullaDocs:false` to skip).
- `sulla meta/read_file` — Read a file with optional line range; can also list a directory.
- `sulla meta/browse_tools` — Discover tools by category or keyword (returns ready-to-run commands + schemas, not executions).
- `sulla meta/execute_workflow` — Execute a pre-registered workflow by its EXACT slug (only when the slug appears verbatim in your prompt).
- `sulla meta/validate_sulla_workflow` — Validate a workflow YAML for structural correctness before it goes live.
- `sulla meta/restart_from_checkpoint` — Restart a workflow execution from a specific node checkpoint.
- `sulla meta/stop_workflow` — Cooperatively request a running workflow to stop (Redis flag honored at next frontier tick).
- `sulla meta/pause_workflow` — Pause a running workflow without releasing it (in-flight sub-agent work is not cancelled).
- `sulla meta/resume_workflow` — Resume a paused workflow.
- `sulla meta/dry_run_workflow` — Statically walk a workflow from triggers — reports execution order, orphans, ambiguous branches (no side effects).

→ See [`tools/meta.md`](meta.md), [`workflows/authoring.md`](../workflows/authoring.md)

## memory — recall / citation index for the subconscious recall path (3 tools)
- `sulla memory/recall_index_lookup` — Check the Redis citation index for previously-researched digests BEFORE re-reading files / re-searching directories.
- `sulla memory/recall_index_store` — Persist freshly-researched citation digests into the Redis citation index (verified by content hash; 24h TTL unless re-hit).
- `sulla memory/recall_conversations` — Search/read the on-disk conversation logs (`~/sulla/logs/conv_*.jsonl`) — full past transcripts (subconscious agents are never logged here).

→ See [`tools/meta.md`](meta.md), [`environment/subconscious.md`](../environment/subconscious.md)

## observation — observational + identity memory (+ home write_file) (9 tools)
- `sulla observation/add_observational_memory` — Store an operational observation into long-term memory (with priority).
- `sulla observation/remove_observational_memory` — Archive (soft-delete) an observational memory by id.
- `sulla observation/search_observations` — Search active observational memories by keyword/phrase (do this before adding, to dedupe).
- `sulla observation/list_observations` — List active observations, critical/high first then recency.
- `sulla observation/add_identity_observation` — Store/update a domain-keyed identity observation (human / business / world / agent / environment / projects) with certainty level 3/2/1.
- `sulla observation/remove_identity_observation` — Archive (soft-delete) an identity observation by id.
- `sulla observation/search_identity_observations` — Search identity observations within one domain (dedupe before adding).
- `sulla observation/list_identity_observations` — List identity observations for one domain, most certain first (L3→L2→L1) then recency.
- `sulla observation/write_file` — Write/overwrite a file. **Restricted to the home directory.** (Category is `observation`; `meta/write_file` resolves to the same tool.)

→ See [`tools/meta.md`](meta.md) (memory + identity sections), [`environment/subconscious.md`](../environment/subconscious.md)

## agents — sub-agent jobs, conversations, and the live agent directory (7 tools)
- `sulla agents/check_agent_jobs` — Fallback/history read of async `spawn_agent` jobs (results normally wake the parent graph on their own).
- `sulla agents/stop_agent_job` — Kill switch: cancel a running async job (cooperative abort, cascades to its sub-agents).
- `sulla agents/start_agent_conversation` — DEPRECATED compatibility shim over async `spawn_agent`; returns a jobId/conversationId alias.
- `sulla agents/send_agent_message` — DEPRECATED; returns migration guidance to `spawn_agent` / `check_agent_jobs`.
- `sulla agents/read_agent_conversation` — Temporary read compatibility for pre-migration conversations.
- `sulla agents/close_agent_conversation` — Temporary close compatibility for pre-migration conversations.
- `sulla agents/list_agents` — Directory of live named agents (heartbeat, workbench, mobile-relay, …) you can `<channel:NAME>`-message.

**ONE delegation pattern:** `sulla meta/spawn_agent` (async results wake the parent graph). `list_agents` + `<channel:NAME>` is messaging to already-running named agents, not delegation. See [`tools/agents.md`](agents.md).

## workflow — routine/workflow lifecycle + schedules (8 tools)
- `sulla workflow/import_workflow` — Import `~/sulla/routines/<slug>/routine.yaml` into the workflows DB so it can execute.
- `sulla workflow/refresh_schedules` — Re-scan production workflows and re-arm schedule triggers; reports armed cron/timezone/next-fire.
- `sulla workflow/catch_up_schedules` — Detect + dispatch scheduled fires missed while the app/scheduler was down (`dryRun` to preview).
- `sulla workflow/set_workflow_status` — Change status (draft | production | archive) or enable/disable, then re-arm the scheduler live.
- `sulla workflow/routines_digest` — Deterministic exceptions-only digest of routine health (the standing routine-stewardship context).
- `sulla workflow/routine_report` — Drill-down for a flagged routine: last-run status/timing/error + step-by-step tool-call trace.
- `sulla workflow/find_repeated_tasks` — Promotion detector: operations recurring across ≥ threshold distinct sessions — candidates to codify as a routine or function.
- `sulla workflow/display_workflow` — Surface a saved routine as a workflow artifact in the chat sidebar (run after import + after each edit).

→ See [`workflows/authoring.md`](../workflows/authoring.md). (Execution/control verbs — execute/validate/pause/resume/stop/dry_run/restart — live under `meta`, above.)

## function — custom functions (3 tools)
- `sulla function/function_list` — List functions in `~/sulla/functions/` (slug, runtime, entrypoint, inputs, outputs).
- `sulla function/function_run` — Execute a function by slug (logs every call to the `function_runs` table).
- `sulla function/function_runs` — Query run history (filter by slug / only_failures / since; verbose for full IO).

→ See [`functions/authoring.md`](../functions/authoring.md)

## browser — web automation (24 tools)
- `sulla browser/browser_controller` — Graph-bound in-app Browser delegation for explicitly capable scheduled graphs; fails closed elsewhere.
- `sulla browser/tab` — Open / navigate / close a tab (`action: upsert | remove`).
- `sulla browser/list` — List open tabs (assetId, URL, title, ready/loading).
- `sulla browser/snapshot` — Dehydrated DOM with clickable handles.
- `sulla browser/text` — Reader-mode text content (+ title, URL, scroll position).
- `sulla browser/form` — Current visible form field values.
- `sulla browser/screenshot` — Capture a screenshot of a tab.
- `sulla browser/click` — Click an element by handle (`@btn-submit`).
- `sulla browser/fill` — Set a form field value (optional submit).
- `sulla browser/press_key` — Press a key (Enter / Escape / Tab / arrows).
- `sulla browser/scroll` — Scroll a CSS-selector element into view.
- `sulla browser/wait` — Wait for a CSS selector to become visible.
- `sulla browser/click_at` — Click at pixel coordinates (trusted CDP event).
- `sulla browser/type_at` — Click + type at coordinates (trusted events).
- `sulla browser/hover` — Move the mouse to coordinates without clicking.
- `sulla browser/eval_js` — Evaluate JS in the active tab with diagnostics.
- `sulla browser/manage_cookies` — Read / set / delete cookies.
- `sulla browser/background_browse` — Browse in a hidden tab without disrupting the visible browser.
- `sulla browser/search_history` — Search browsing history by text / time range.
- `sulla browser/modify_history` — Add / delete / clear history entries.
- `sulla browser/search_conversations` — Search past chats, browser visits, and workflow runs (DB titles/summaries).
- `sulla browser/agent_storage` — Persistent KV for agent state across conversations.
- `sulla browser/monitor_network` — Capture/watch network requests for a duration.
- `sulla browser/schedule_alarm` — Set / list / clear named in-process timers (do NOT survive restart).

→ See [`tools/browser.md`](browser.md)

## github — git + GitHub API (52 tools)
**Local git:** `git_status`, `git_add`, `git_commit`, `git_push`, `git_pull`, `git_branch`, `git_checkout`, `git_log`, `git_diff`, `git_blame`, `git_conflicts`, `git_stash`, `git_worktree`.
**Repo/init:** `github_init`, `github_add_remote`, `github_create_repo`, `github_get_repo`, `github_list_repos`, `github_delete_repo`, `github_fork_repo`, `github_list_branches`, `github_create_ref`, `github_delete_ref`.
**Files via API:** `github_read_file`, `github_create_file`, `github_update_file`.
**Issues:** `github_create_issue`, `github_get_issue`, `github_get_issues`, `github_get_issue_comments`, `github_update_issue`, `github_close_issue`, `github_comment_on_issue`.
**Pull requests:** `github_create_pr`, `github_get_pr`, `github_list_prs`, `github_update_pr`, `github_ready_pr`, `github_close_pr`, `github_merge_pr`, `github_add_pr_review`, `github_list_pr_reviews`, `github_request_pr_reviewers`, `github_get_pr_files`.
**Releases/CI:** `github_create_release`, `github_check_runs`, `github_trigger_workflow_run`.
**Projects V2 boards:** `github_list_projects`, `github_add_issue_to_project`, `github_set_project_field`.
**Heartbeat issue-discovery (#500):** `heartbeat_new_issues`, `heartbeat_claim_issue`.

`git_push`/`git_pull` inject the vault PAT automatically — never extract it for raw git. Merges require `confirm:true`. → See [`tools/github.md`](github.md)

## pg — PostgreSQL (6 tools)
- `sulla pg/pg_query` — SELECT (rows).
- `sulla pg/pg_queryall` — SELECT, all rows (explicit).
- `sulla pg/pg_queryone` — SELECT, first row only.
- `sulla pg/pg_count` — COUNT scalar.
- `sulla pg/pg_execute` — INSERT / UPDATE / DELETE.
- `sulla pg/pg_transaction` — Atomic multi-statement transaction.

→ See [`tools/pg.md`](pg.md)

## redis — Redis KV (12 tools)
- Strings: `redis_get`, `redis_set`, `redis_del`. Counters: `redis_incr`, `redis_decr`. TTL: `redis_expire`, `redis_ttl`.
- Hashes: `redis_hget`, `redis_hset`, `redis_hgetall`. Lists: `redis_lpop`, `redis_rpush`.

**Do not use these on `sulla_settings`** — that hash is owned by `SullaSettingsModel` and the redis tools refuse it. Use `settings/*`. → See [`tools/redis.md`](redis.md)

## settings — authoritative settings path (2 tools)
- `sulla settings/settings_get` — Read through `SullaSettingsModel` (Redis cache → Postgres → file fallback).
- `sulla settings/settings_set` — Write through `SullaSettingsModel` (Postgres + Redis write-through).

→ See [`tools/settings.md`](settings.md)

## vault — credential vault (8 tools)
- `sulla vault/vault_is_enabled` — Is integration X connected?
- `sulla vault/vault_list_accounts` — Accounts on integration X.
- `sulla vault/vault_read_secrets` — Read credential fields (masked per LLM access level).
- `sulla vault/vault_set_credential` — Create / update a credential.
- `sulla vault/vault_set_active_account` — Set the default account for an integration.
- `sulla vault/vault_list` — List saved website credentials (no passwords).
- `sulla vault/vault_autofill` — Inject saved credentials into the active browser tab.
- `sulla vault/vault_delete_credential` — Delete a credential property (requires `confirm:true`).

→ See [`tools/vault.md`](vault.md)

## calendar — local Postgres-backed events (7 tools)
- `sulla calendar/calendar_create` — Create an event / reminder.
- `sulla calendar/calendar_get` — Fetch one by id.
- `sulla calendar/calendar_list` — List within a date range.
- `sulla calendar/calendar_list_upcoming` — Next N days (default 7).
- `sulla calendar/calendar_update` — Patch an event.
- `sulla calendar/calendar_cancel` — Soft cancel (status='cancelled').
- `sulla calendar/calendar_delete` — Hard delete.

→ See [`tools/calendar.md`](calendar.md)

## notify — desktop + mobile notifications (2 tools)
- `sulla notify/notify_user` — Desktop + mobile fan-out (`targets:["desktop","mobile"]`; logged to `notifications`).
- `sulla notify/history` — Query notification history (filter by target / only_failures / since).

→ See [`tools/notify.md`](notify.md)

## bridge — human presence (2 tools)
- `sulla bridge/update_human_presence` — Publish what the human is viewing/doing + availability to Redis.
- `sulla bridge/get_human_presence` — Read the current human-presence state.

→ See [`tools/notify.md`](notify.md)

## slack — messaging (7 tools)
- `sulla slack/slack_send_message` — Post to a channel / DM.
- `sulla slack/slack_update` — Edit a message.
- `sulla slack/slack_thread` — Get thread replies.
- `sulla slack/slack_search_users` — Find a user by name / email.
- `sulla slack/slack_user` — Get one user.
- `sulla slack/slack_unreact` — Remove a reaction.
- `sulla slack/slack_connection_health` — Health check + auto-recovery.

→ See [`tools/slack.md`](slack.md)

## mobile — Sulla Mobile companion (read-only) (5 tools)
- `sulla mobile/list_calls` — Recent AI-receptionist calls (filter by status).
- `sulla mobile/get_call` — Full call details (transcript, summary, lead metadata).
- `sulla mobile/list_leads` — Inbox leads (filter by qualified/urgency).
- `sulla mobile/list_messages` — SMS + voicemail transcripts (filter unread).
- `sulla mobile/list_devices` — Every desktop + mobile device registered to the contractor, with online/offline status.

Hits sulla-workers with the mobile JWT from vault `sulla-cloud/api_token`. → See [`mobile/overview.md`](../mobile/overview.md)

## project — Projects project-state (the ONE work-state store) (13 tools)
- `sulla project/list_project_items` — List projects / epics / tasks (filter by kind / status / priority / project / epic / parent / assignee).
- `sulla project/get_project_item` — One item + children + comments.
- `sulla project/search_project_items` — Title + description search (dedupe before create).
- `sulla project/project_report` — Standup: completed last N hours (default 24) + top open tasks.
- `sulla project/create_project` / `update_project` — Project CRUD.
- `sulla project/create_epic` / `update_epic` — Epic CRUD (under a project).
- `sulla project/create_task` / `update_task` — Task CRUD (`parent_id` for a subtask).
- `sulla project/add_task_comment` — Append a note (author defaults `sulla`; Heartbeat passes `heartbeat`; UI stamps `human`).
- `sulla project/list_task_comments` — Comment thread, oldest first.
- `sulla project/archive_project_item` — Soft-archive a project / epic / task (cascades).

The ONE project-state store — not CRM, distinct from the `~/sulla/projects/<slug>/PROJECT.md` PRDs. → See [`tools/project.md`](project.md)

## ledger — leftover ledger scoreboard (NOT the pick-path) (1 tool)
- `sulla ledger/ledger_scoreboard` — Zero-LLM scoreboard over the leftover `~/sulla/ledger/` markdown archive. Do **not** pick work from those files — the agenda lives in the project tables.

→ See [`tools/ledger.md`](ledger.md)

## models — AI provider / model inventory (3 tools)
- `sulla models/models_providers` — Providers, connected/on vs off, whether the required CLI is installed in the VM, and whether Sulla can use it.
- `sulla models/models_list` — Models for one provider (live discovery, static-catalog fallback).
- `sulla models/models_usage` — Locally-tracked model usage (Codex + Claude Code rolling usage today).

→ See [`tools/models.md`](models.md)

## applescript — macOS app automation (5 tools)
- `sulla applescript/applescript_execute` — Drive a `target_app` via AppleScript (per-app allowlist); every call logged to `applescript_audit`.
- `sulla applescript/computer_use_list` — List allowlisted apps + enabled state.
- `sulla applescript/computer_use_enable` — Enable an app target.
- `sulla applescript/computer_use_disable` — Disable an app target.
- `sulla applescript/audit_log` — Query the AppleScript audit log (filter by target_app / only_failures / since).

→ See [`tools/applescript.md`](applescript.md), [`tools/computer-use.md`](computer-use.md)

## capture — Capture Studio control (headless) (20 tools)
**Teleprompter:** `teleprompter_open`, `teleprompter_close`, `teleprompter_status`, `teleprompter_script`, `teleprompter_style`.
**Audio (ref-counted):** `mic_start`, `mic_stop`, `speaker_start`, `speaker_stop`, `audio_state`.
**Recording:** `recorder_start`, `recorder_stop`, `recorder_status`.
**Camera:** `camera_list`, `camera_set`, `camera_release`.
**Screen / screenshots:** `list_screens`, `screen_set`, `screenshot`, `quality_set` (480p | 720p | 1080p | 4k | auto).

→ See [`tools/capture.md`](capture.md), [`desktop/capture-studio.md`](../desktop/capture-studio.md)

## ui — open Sulla Desktop views from chat (1 tool)
- `sulla ui/open_tab` — Open/focus a built-in view (`mode`: marketplace, vault, integrations, routines, history, secretary, chat, document, browser, projects, agents) — or pass `url` for a raw browser tab.

→ See [`tools/ui.md`](ui.md)

## marketplace — generic artifact lifecycle, all 6 kinds (11 tools)
- `search`, `info`, `download`, `scaffold`, `validate`, `publish`, `unpublish`, `list_local`, `list_published`, `update`, `diff`.
- Kinds: skill / function / workflow / agent / recipe / integration. `unpublish` requires `confirm:true`.

→ See [`tools/marketplace.md`](marketplace.md)

## extensions — marketplace recipe lifecycle (7 tools)
- `list_extension_catalog`, `list_installed_extensions`, `install_extension`, `uninstall_extension` (preserves data by default), `start_extension`, `stop_extension` (`confirm:true`), `get_extension_status`.

→ See [`marketplace/overview.md`](../marketplace/overview.md)

## docker — host Docker daemon (NOT Lima services) (9 tools)
- `docker_ps`, `docker_images`, `docker_pull`, `docker_run`, `docker_exec`, `docker_logs`, `docker_stop`, `docker_rm`, `docker_build`.

⚠️ **`docker_ps` does NOT show Lima-internal services** (`sulla_postgres`, `sulla_redis`, the runtimes). → See [`environment/docker.md`](../environment/docker.md)

## lima — VM management (6 tools)
- `lima_list`, `lima_create`, `lima_start`, `lima_stop`, `lima_shell` (always pass `command`), `lima_delete`.

→ See [`environment/docker.md`](../environment/docker.md)

## kubectl — k3s in Lima (3 tools)
- `kubectl_apply` (offer `dryRun:'server'`), `kubectl_delete` (confirm before `force:true`), `kubectl_describe`. For `get`/`logs`, fall back to `rdctl_shell`.

→ See [`environment/kubernetes.md`](../environment/kubernetes.md)

## rdctl — Rancher / Sulla VM control (10 tools)
- `rdctl_info`, `rdctl_list_settings`, `rdctl_set` (updates + restarts backend), `rdctl_shell` (single command + args — no pipes/redirects/`&&`), `rdctl_extension`, `rdctl_snapshot`, `rdctl_start`, `rdctl_shutdown`, `rdctl_reset` (**destructive — wipes the cluster**), `rdctl_version`.

→ See [`environment/kubernetes.md`](../environment/kubernetes.md)

## secretary — Secretary Mode, live meeting transcription (3 tools)
- `sulla secretary/start` — Open/focus a Secretary tab and begin listening.
- `sulla secretary/stop` — End the listening session.
- `sulla secretary/status` — Is Secretary Mode listening?

→ See [`desktop/secretary-mode.md`](../desktop/secretary-mode.md)

---

## Integration proxy pattern

For external SaaS APIs the agent calls via the proxy form:
```bash
sulla <account_id>/<integration_slug> '{"method":"GET","path":"/api/...","body":{...}}'
```
`<account_id>` first, then `/`, then `<integration_slug>`. Example:
```bash
sulla jonathonbyrdziaks_token/github '{"method":"GET","path":"/user/repos"}'
```
Account IDs are discoverable via `sulla vault/vault_list_accounts '{"account_type":"<slug>"}'`. Credentials are auto-injected — the agent never handles raw tokens. Third-party tools (e.g. n8n) install as **recipes** (extensions) and are reached via this proxy after install — no special tool category needed.

---

## Summary counts (regenerated from source manifests 2026-08-19)

| Category | Tools | | Category | Tools |
|----------|------:|-|----------|------:|
| github | 52 | | extensions | 7 |
| browser | 23 | | pg | 6 |
| capture | 20 | | lima | 6 |
| meta | 14 | | mobile | 5 |
| project | 13 | | applescript | 5 |
| redis | 12 | | function | 3 |
| marketplace | 11 | | secretary | 3 |
| rdctl | 10 | | kubectl | 3 |
| observation | 9 | | memory | 3 |
| docker | 9 | | models | 3 |
| workflow | 8 | | settings | 2 |
| vault | 8 | | notify | 2 |
| slack | 7 | | bridge | 2 |
| agents | 7 | | ui | 1 |
| calendar | 7 | | ledger | 1 |
| | | | **Total** | **262** |

If a new category appears in `pkg/rancher-desktop/agent/tools/` or `sulla <cat> --help` that's not on this list, add it here AND write a doc.
