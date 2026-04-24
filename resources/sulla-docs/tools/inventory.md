# Tool Inventory

Master list of every tool the agent can call. **Verified against the live backend 2026-04-23.** Each line is `sulla <category>/<tool> — purpose`.

**Important routing note:** the backend resolves tools by **name only** — the category segment in the URL is ignored. So `sulla anything/spawn_agent` works the same as `sulla meta/spawn_agent`. But the **canonical** form (what `sulla <cat> --help` lists) is what you should use for clarity. Categories and canonical pairings below.

When in doubt about a tool, the live source of truth is:
```bash
sulla <category> --help
```
(requires `SULLA_API_TOKEN` from `~/Library/Application Support/rancher-desktop/chat-api-token.json` + `SULLA_HOST=localhost` when running outside Lima)

---

## meta — system foundation + workflow execution (13 tools)
- `sulla meta/exec` — Run shell commands inside the Lima VM (root, 2-min default timeout, 160KB output cap)
- `sulla meta/browse_tools` — Discover tools by category or keyword (returns docs, not executions)
- `sulla meta/file_search` — Semantic vector search across files
- `sulla meta/read_file` — Read file with optional line range
- `sulla meta/request_user_input` — Pause mid-turn and ask the user for an approve/deny decision (blocks until user clicks; 5 min default timeout)
- `sulla meta/spawn_agent` — Launch sub-agents (canonical for spawn_agent; NOT under `agents/`)
- `sulla meta/execute_workflow` — Run a named Sulla workflow by slug
- `sulla meta/validate_sulla_workflow` — Validate workflow YAML
- `sulla meta/restart_from_checkpoint` — Resume workflow from a specific node
- `sulla meta/stop_workflow` — Request a running workflow to stop (cooperative — Redis flag, honored at next frontier tick)
- `sulla meta/pause_workflow` — Pause without releasing (in-flight work continues)
- `sulla meta/resume_workflow` — Resume a paused workflow
- `sulla meta/dry_run_workflow` — Static walk from triggers — reports execution order, orphans, ambiguous branches (no side effects)

→ See [`tools/meta.md`](meta.md), [`workflows/authoring.md`](../workflows/authoring.md)

## observation — memory + file writes (3 tools)
- `sulla observation/add_observational_memory` — Store an observation with priority
- `sulla observation/remove_observational_memory` — Delete by 4-char id
- `sulla observation/write_file` — Write / overwrite file in home dir (also works as `meta/write_file` — category is ignored)

→ See [`tools/meta.md`](meta.md) for the memory + write_file section

## function — custom functions (3 tools)
- `sulla function/function_list` — List functions in `~/sulla/functions/`
- `sulla function/function_run` — Execute by slug (logs every call to `function_runs` table)
- `sulla function/function_runs` — Query run history (filter by slug / only_failures / since; verbose for full inputs/outputs)

**Note:** the host CLI script (`/Users/jonathonbyrdziak/.rd/bin/sulla`) has a stale category whitelist that may route `function/*` through the proxy path and fail. The agent inside the desktop calls tools via registry directly, so these work. From the host, use the direct backend URL form if the CLI fails.

→ See [`functions/authoring.md`](../functions/authoring.md)

## browser — web automation (23 tools)
- `sulla browser/tab` — Open / navigate / close tabs (upsert/remove)
- `sulla browser/list` — List open tabs
- `sulla browser/snapshot` — Dehydrated DOM with handles (~5k tokens)
- `sulla browser/text` — Reader-mode text content
- `sulla browser/form` — Current form field values
- `sulla browser/screenshot` — Save image to disk; grid + annotate options
- `sulla browser/click` — Click by handle (`@btn-submit`)
- `sulla browser/fill` — Set form value, optional submit
- `sulla browser/press_key` — Enter / Escape / Tab / arrows
- `sulla browser/scroll` — Scroll element into view (CSS selector)
- `sulla browser/wait` — Wait for selector to appear
- `sulla browser/click_at` — Click at pixel coords (CDP trusted event)
- `sulla browser/type_at` — Click + type at coords
- `sulla browser/hover` — Mouse to coords (no click)
- `sulla browser/eval_js` — Run JS with diagnostics
- `sulla browser/manage_cookies` — Get/getAll/set/remove cookies
- `sulla browser/modify_history` — Add/delete/clear history entries
- `sulla browser/search_history` — Search browser history
- `sulla browser/search_conversations` — Search chats / browser visits / workflow runs
- `sulla browser/agent_storage` — Persistent KV across conversations
- `sulla browser/monitor_network` — Capture or watch network requests
- `sulla browser/background_browse` — Hidden tab browsing
- `sulla browser/schedule_alarm` — In-process timers (don't survive restart)

→ See [`tools/browser.md`](browser.md)

## github (28 tools)
- `sulla github/git_status` — Working tree status
- `sulla github/git_add` — Stage files
- `sulla github/git_commit` — Stage + commit
- `sulla github/git_push` — Push to remote (PAT injected from vault)
- `sulla github/git_pull` — Pull from remote
- `sulla github/git_branch` — Create / switch / delete / list
- `sulla github/git_checkout` — Restore from commit / branch
- `sulla github/git_log` — Commit history
- `sulla github/git_diff` — Diff working / staged / commits
- `sulla github/git_blame` — Per-line attribution
- `sulla github/git_conflicts` — List conflicted files
- `sulla github/git_stash` — Save / list / apply / pop / drop
- `sulla github/github_init` — git init at path
- `sulla github/github_add_remote` — Add remote
- `sulla github/github_list_branches` — List remote branches
- `sulla github/github_read_file` — Read file via GitHub API
- `sulla github/github_create_file` — Create file via API
- `sulla github/github_update_file` — Update via API
- `sulla github/github_create_issue` — Open new issue
- `sulla github/github_get_issue` — Fetch one
- `sulla github/github_get_issues` — List with filters
- `sulla github/github_update_issue` — Update title/body/labels/assignees
- `sulla github/github_close_issue` — Close with optional reason
- `sulla github/github_comment_on_issue` — Add comment
- `sulla github/github_create_pr` — Open PR
- `sulla github/github_merge_pr` — Merge a PR (merge / squash / rebase; requires `confirm:true`)
- `sulla github/github_check_runs` — List CI check runs for a ref (is CI green?)
- `sulla github/github_trigger_workflow_run` — Dispatch a workflow manually (requires workflow_dispatch trigger)

→ See [`tools/github.md`](github.md)

## docker — host Docker daemon (whatever the user has installed — e.g. Docker Desktop)
- `sulla docker/docker_ps` — List containers (host, NOT Lima)
- `sulla docker/docker_images` — List images
- `sulla docker/docker_pull` — Pull from registry
- `sulla docker/docker_run` — Run container
- `sulla docker/docker_exec` — Run command in running container
- `sulla docker/docker_logs` — Tail / follow logs
- `sulla docker/docker_stop` — Stop container
- `sulla docker/docker_rm` — Remove container
- `sulla docker/docker_build` — Build from Dockerfile

⚠️ **docker_ps does NOT show Lima-internal services** (sulla_postgres, sulla_redis, python_runtime, etc.) See [`environment/docker.md`](../environment/docker.md).

## lima — VM management (6 tools)
- `sulla lima/lima_list` — List instances
- `sulla lima/lima_create` — Create from template
- `sulla lima/lima_start` — Start instance
- `sulla lima/lima_stop` — Stop instance
- `sulla lima/lima_shell` — Run command (always pass `command`, never go interactive)
- `sulla lima/lima_delete` — Delete instance

→ See [`environment/docker.md`](../environment/docker.md)

## kubectl — k3s in Lima (3 tools)
- `sulla kubectl/kubectl_apply` — Apply manifest (offer `dryRun:'server'` for unfamiliar)
- `sulla kubectl/kubectl_delete` — Delete resource (confirm before `force:true`)
- `sulla kubectl/kubectl_describe` — Resource details

For `kubectl get`, `kubectl logs`, etc. → workaround via `rdctl_shell`.

→ See [`environment/kubernetes.md`](../environment/kubernetes.md)

## rdctl — Rancher Desktop / Sulla VM control (10 tools)
- `sulla rdctl/rdctl_info` — App version / runtime / features
- `sulla rdctl/rdctl_list_settings` — Current settings
- `sulla rdctl/rdctl_set` — Update setting + restart backend
- `sulla rdctl/rdctl_shell` — Shell command in Lima. **Does NOT accept pipes, redirects, or `&&` — single command + args only**
- `sulla rdctl/rdctl_extension` — Install / uninstall extensions (lower-level than `extensions/*`)
- `sulla rdctl/rdctl_snapshot` — VM snapshot management
- `sulla rdctl/rdctl_start` — Start the backend
- `sulla rdctl/rdctl_shutdown` — Shut down the backend
- `sulla rdctl/rdctl_reset` — **Destructive — wipes the cluster**
- `sulla rdctl/rdctl_version` — rdctl version

→ See [`environment/kubernetes.md`](../environment/kubernetes.md)

## calendar — local Postgres-backed events (7 tools)
- `sulla calendar/calendar_create` — Create event / reminder
- `sulla calendar/calendar_get` — Fetch one
- `sulla calendar/calendar_list` — List in date range
- `sulla calendar/calendar_list_upcoming` — Next N days (default 7)
- `sulla calendar/calendar_update` — Patch event
- `sulla calendar/calendar_cancel` — Soft cancel (status='cancelled')
- `sulla calendar/calendar_delete` — Hard delete

→ See [`tools/calendar.md`](calendar.md)

## vault — credentials (8 tools)
- `sulla vault/vault_is_enabled` — Is integration X connected?
- `sulla vault/vault_list_accounts` — Accounts on integration X
- `sulla vault/vault_read_secrets` — Read fields (masked per access level)
- `sulla vault/vault_set_credential` — Create / update credential
- `sulla vault/vault_set_active_account` — Set default account
- `sulla vault/vault_list` — List website credentials (no passwords)
- `sulla vault/vault_autofill` — Inject credentials into active browser tab
- `sulla vault/vault_delete_credential` — Delete a credential property (requires `confirm:true`)

→ See [`tools/vault.md`](vault.md)

## extensions — marketplace recipes (7 tools)
- `sulla extensions/list_extension_catalog` — Browse marketplace
- `sulla extensions/list_installed_extensions` — What's installed (with URLs)
- `sulla extensions/install_extension` — Install by ID
- `sulla extensions/uninstall_extension` — Uninstall (default preserves data)
- `sulla extensions/start_extension` — Bring a stopped recipe back up
- `sulla extensions/stop_extension` — Stop a running recipe (`confirm:true` required)
- `sulla extensions/get_extension_status` — running / stopped / not_installed

→ See [`marketplace/overview.md`](../marketplace/overview.md)

## marketplace — generic artifact lifecycle (11 tools, all 6 kinds)
- `sulla marketplace/search` — Search by query / kind / category (cloud + GitHub fallback for recipes)
- `sulla marketplace/info` — Full metadata for `kind` + `slug`
- `sulla marketplace/download` — Pull and materialise locally (`overwrite` flag)
- `sulla marketplace/scaffold` — Generate kind-appropriate skeleton dir
- `sulla marketplace/validate` — Schema check against the kind's contract
- `sulla marketplace/publish` — POST to Sulla Cloud marketplace
- `sulla marketplace/unpublish` — DELETE published artifact (`confirm:true` required)
- `sulla marketplace/list_local` — Locally-installed artifacts (filterable by kind)
- `sulla marketplace/list_published` — Artifacts the current user has published
- `sulla marketplace/update` — Pull latest version (overwrites local)
- `sulla marketplace/diff` — Compare local artifact vs marketplace version (preview before update)

→ See [`tools/marketplace.md`](marketplace.md)

## redis (12 tools)
- `sulla redis/redis_get` / `redis_set` — String KV
- `sulla redis/redis_del` — Delete keys
- `sulla redis/redis_incr` / `redis_decr` — Integer counters
- `sulla redis/redis_expire` / `redis_ttl` — TTL management
- `sulla redis/redis_hget` / `redis_hset` / `redis_hgetall` — Hash fields
- `sulla redis/redis_lpop` / `redis_rpush` — List ops

→ See [`tools/redis.md`](redis.md)

## pg — PostgreSQL queries (6 tools)
- `sulla pg/pg_query` — SELECT, all rows
- `sulla pg/pg_queryall` — SELECT, all rows (explicit)
- `sulla pg/pg_queryone` — SELECT, first row only
- `sulla pg/pg_count` — COUNT scalar
- `sulla pg/pg_execute` — INSERT / UPDATE / DELETE
- `sulla pg/pg_transaction` — Atomic multi-statement

→ See [`tools/pg.md`](pg.md)

## slack (7 tools)
- `sulla slack/slack_send_message` — Post to channel / DM
- `sulla slack/slack_update` — Edit message
- `sulla slack/slack_thread` — Get thread replies
- `sulla slack/slack_search_users` — Find user by name / email
- `sulla slack/slack_user` — Get one user
- `sulla slack/slack_unreact` — Remove reaction
- `sulla slack/slack_connection_health` — Health check + auto-recovery

→ See [`tools/slack.md`](slack.md)

## mobile — Sulla Mobile companion (4 tools)
- `sulla mobile/list_calls` — Recent AI-receptionist calls (filter by status)
- `sulla mobile/get_call` — Full call details (transcript, lead metadata, summary)
- `sulla mobile/list_leads` — Inbox leads (filter by qualified_only / urgency)
- `sulla mobile/list_messages` — SMS + voicemail transcripts (filter unread_only)

Read-only. Hits sulla-workers with the mobile JWT from vault `sulla-cloud/api_token`.

## agents — sub-agent jobs (1 tool)
- `sulla agents/check_agent_jobs` — Poll for results of async spawn_agent calls

**`spawn_agent` is NOT under `agents/`** — it's canonically `sulla meta/spawn_agent`. See [`tools/agents.md`](agents.md).

## bridge — human presence (2 tools)
- `sulla bridge/get_human_presence` — Read presence state from Redis
- `sulla bridge/update_human_presence` — Update presence

→ See [`tools/notify.md`](notify.md)

## notify — desktop + mobile notifications (2 tools)
- `sulla notify/notify_user` — Desktop + mobile fan-out (`targets: ["desktop","mobile"]`; logged to `notifications` table)
- `sulla notify/history` — Query the notification history (filter by target / only_failures / since)

→ See [`tools/notify.md`](notify.md)

## applescript — macOS app automation (5 tools)
- `sulla applescript/applescript_execute` — Drive a target_app via AppleScript (per-app allowlist); every call logged to `applescript_audit`
- `sulla applescript/computer_use_list` — List allowlisted apps
- `sulla applescript/computer_use_enable` — Toggle an app on
- `sulla applescript/computer_use_disable` — Toggle an app off
- `sulla applescript/audit_log` — Query applescript_audit (filter by target_app / only_failures / since)

→ See [`tools/applescript.md`](applescript.md), [`tools/computer-use.md`](computer-use.md)

## ui — open Sulla Desktop views from chat (1 tool)
- `sulla ui/open_tab` — Open / focus a built-in view (`mode`: marketplace, vault, integrations, routines, history, secretary, chat, document, browser, welcome, settings) — or pass `url` to open a raw browser tab

→ See [`tools/ui.md`](ui.md)

## capture — Capture Studio control (13 tools)
**Teleprompter:**
- `sulla capture/teleprompter_open` — Open the floating script window
- `sulla capture/teleprompter_close` — Close it
- `sulla capture/teleprompter_status` — Is it open?
- `sulla capture/teleprompter_script` — Push script text (auto-opens, sets `currentIndex`)
- `sulla capture/teleprompter_style` — Update fontSize / highlightColor

**Microphone (ref-counted):**
- `sulla capture/mic_start` — Start mic capture (optional `formats: ["webm-opus","pcm-s16le"]`)
- `sulla capture/mic_stop` — Release this agent's hold

**Speaker / desktop audio loopback (ref-counted):**
- `sulla capture/speaker_start` — Start system-audio capture
- `sulla capture/speaker_stop` — Release hold

**State + screens:**
- `sulla capture/audio_state` — Are mic/speaker capturing? Which devices?
- `sulla capture/list_screens` — Enumerate displays + windows (`kind: screen | window | all`)
- `sulla capture/screenshot` — PNG of a screen/window → `~/sulla/captures/screenshots/YYYY-MM-DD/`

→ See [`tools/capture.md`](capture.md)

---

## Categories visible in CLI --help but NOT in `sulla --help` output

The host CLI script has a stale hardcoded `TOOL_CATEGORIES` whitelist. These categories exist on the backend (`sulla <cat> --help` works) but aren't in the top-level `sulla --help` list:
- **`function`** (2 tools)
- **`observation`** (3 tools)

These categories work when called directly. The `workflow` category does NOT exist on the backend (returns "Unknown category") — use `meta/` for workflow tools.

---

## Integration proxy pattern

For external SaaS APIs the agent calls via the proxy form:
```bash
sulla <account_id>/<integration_slug> '{"method":"GET","path":"/api/...","body":{...}}'
```

**Verified format:** `<account_id>` first, then `/`, then `<integration_slug>`. Example:
```bash
sulla jonathonbyrdziaks_token/github '{"method":"GET","path":"/user/repos"}'
```

Account IDs are discoverable via `sulla vault/vault_list_accounts '{"account_type":"<slug>"}'`. The slug (second segment) is typically the same as the integration name. Credentials are auto-injected — the agent never handles raw tokens.

Common integrations (as of verification):
- `github` (user has `jonathonbyrdziaks_token` account connected)
- `slack`, `twenty`, `intuit`, `openai`, `anthropic` (connect as needed). Third-party tools like n8n are installable as **recipes** (extensions) — hit them via the integration proxy pattern after install, no special tool category needed.

---

## Summary counts (verified live 2026-04-23)

| Category | Tool count |
|----------|-----------|
| meta | 12 |
| observation | 3 |
| browser | 23 |
| github | 28 |
| docker | 9 |
| lima | 6 |
| kubectl | 3 |
| rdctl | 10 |
| calendar | 7 |
| vault | 8 |
| extensions | 7 |
| marketplace | 11 |
| redis | 12 |
| pg | 6 |
| slack | 7 |
| mobile | 4 |
| agents | 1 |
| bridge | 2 |
| notify | 2 |
| applescript | 5 |
| function | 3 |
| ui | 1 |
| capture | 13 |
| **Total** | **~183** |

If a new category appears in `pkg/rancher-desktop/agent/tools/` or `sulla <cat> --help` that's not on this list, add it here AND write a doc.
