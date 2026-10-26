# Tool Inventory

Master list of every tool the agent can call, rebuilt from the live catalog (`sulla meta/browse_tools '{"category":"<cat>"}'` for each category, 2026-10-19). **37 categories, 353 tools.** Each line is `sulla <category>/<tool> — purpose`.

**Routing note:** the catalog resolves tools by category and name. Use the category shown here. `sulla meta/spawn_agent` is the canonical form for `spawn_agent`, even though the tool file lives under `agents/`.

Check what **this** install exposes with:
```bash
sulla meta/browse_tools '{"category":"<category>"}'
```

---

## meta (11 tools)
- `sulla meta/spawn_agent` — The one way to delegate.
- `sulla meta/exec` — Run any shell command inside a fully isolated sandboxed Linux VM with root access.
- `sulla meta/exechost` — LAST RESORT host shell — runs a command on the HOST macOS machine, NOT the Sulla VM.
- `sulla meta/ask_user_question` — Pause and ask the user one or more multiple-choice questions, then BLOCK until they answer in the chat (or the timeout elapses — default 5 min).
- `sulla meta/execute_workflow` — Execute a pre-registered workflow by its EXACT slug.
- `sulla meta/validate_sulla_workflow` — Validate a Sulla workflow YAML file for structural correctness before it goes live.
- `sulla meta/restart_from_checkpoint` — Restart a workflow execution from a specific node checkpoint.
- `sulla meta/stop_workflow` — Request a running workflow to stop.
- `sulla meta/pause_workflow` — Pause a running workflow without releasing it.
- `sulla meta/resume_workflow` — Resume a workflow paused with pause_workflow by clearing its pause flag.
- `sulla meta/dry_run_workflow` — Walk a workflow statically — parse YAML, traverse from triggers, report execution order and any orphans or runtime-ambiguous branches.

→ See [`tools/meta.md`](meta.md), [`workflows/authoring.md`](../workflows/authoring.md)

## memory (9 tools)
- `sulla memory/episodic_resolve` — Resolve aliases to canonical active Knowledge Base nodes.
- `sulla memory/episodic_search` — Search canonical Knowledge Base nodes without mutating recall or graph strength.
- `sulla memory/episodic_recall` — Recall Knowledge Base nodes with direct then inherited Projects scope before ordinary fallback.
- `sulla memory/episodic_link_project_item` — Attach a Knowledge Base node to exactly one Projects item through the shared association model.
- `sulla memory/episodic_unlink_project_item` — Soft-unlink one direct Knowledge Base to Projects association.
- `sulla memory/episodic_list_linked_project_items` — Reverse lookup Projects items directly associated with a Knowledge Base node, with ancestry.
- `sulla memory/recall_index_lookup` — Check the Redis citation index for previously-researched digests BEFORE re-reading files or re-searching directories.
- `sulla memory/recall_index_store` — Persist freshly-researched citation digests into the Redis citation index so future recall passes can reuse them without re-reading source files.
- `sulla memory/recall_conversations` — Search and read the on-disk conversation logs (~/sulla/logs/conv_*.jsonl) — the training-formatted JSONL transcripts of every past user-facing conversation (subconscious agents...

## observation (12 tools)
- `sulla observation/upsert_conversation_keywords` — Observer-only database writer for salient terms from the completed conversation turn.
- `sulla observation/search_conversation_keywords` — Read-only search for the Conversation Reader over the conversation_keywords index.
- `sulla observation/add_observational_memory` — Use this tool to store the observations you make into long-term memory.
- `sulla observation/search_conversation_logs` — Read-only search over ~/sulla/logs/ for the Conversation Reader.
- `sulla observation/remove_observational_memory` — Archive (soft-delete) a specific observational memory by its ID.
- `sulla observation/search_observations` — Search active observational memories by meaning with the ranked recall engine (keyword + embedding search + learned ranker), so paraphrases match.
- `sulla observation/list_observations` — List active observational memories sorted by priority (critical/high first) then recency.
- `sulla observation/add_identity_observation` — Store a focused identity observation into the domain-keyed identity_observations table (human / business / world / agent / environment / projects / skills — mirrors ~/sulla/iden...
- `sulla observation/remove_identity_observation` — Archive (soft-delete) an identity observation by its ID.
- `sulla observation/search_identity_observations` — Search active identity observations within one domain (human / business / world / agent / environment / projects / skills) by meaning with the ranked recall engine (keyword + em...
- `sulla observation/list_identity_observations` — List active identity observations for one domain, most certain first (L3 stated → L2 derived → L1 concluded) then most recent.
- `sulla observation/update_identity_section` — Write the consolidated identity profile for a domain into its system-prompt section (e.g.

## agents (11 tools)
- `sulla agents/return_result` — Finish your delegated task by returning its contract to the agent that launched you (hidden worker or agent tab).
- `sulla agents/check_agent_jobs` — Inspect delegated jobs (hidden and tab), including visibility, contract, per-task elapsed time, latest and recent check-ins, blockers, touched files, and undelivered orchestrato...
- `sulla agents/send_job_message` — Send new direction to one or all running tasks in a delegated job, hidden or tab.
- `sulla agents/report_progress` — Record a milestone check-in for your current delegated task (hidden worker or agent tab).
- `sulla agents/stop_agent_job` — Kill switch for a running delegated job, hidden or tab.
- `sulla agents/start_agent_conversation` — DEPRECATED compatibility wrapper over spawn_agent.
- `sulla agents/send_agent_message` — DEPRECATED conversation compatibility surface.
- `sulla agents/read_agent_conversation` — Read the transcript of an open sub-agent conversation, or list all open conversations when called without a conversationId.
- `sulla agents/close_agent_conversation` — Close a sub-agent conversation and free its resources (drops the sub-agent's graph + state).
- `sulla agents/list_agents` — List the live named agents you can message (heartbeat, mobile-relay, other frontends) with their channel, status, and uptime — the roster from turn context, queryable on demand.
- `sulla agents/directory` — Directory of every callable custom agent (from agent_definitions) as compact cards: when to call it, when not to, what to send, what it returns, cost tier, and which agents it c...

## workflow (8 tools)
- `sulla workflow/import_workflow` — Import an inline YAML workflow definition into Postgres so it can be executed.
- `sulla workflow/refresh_schedules` — Force WorkflowSchedulerService to re-scan production workflows and re-arm all schedule triggers, then report exactly what is armed (cron, timezone, next fire time).
- `sulla workflow/catch_up_schedules` — Detect scheduled workflow fires that were missed (app off or scheduler dormant when the cron time passed) and dispatch them through the real executor.
- `sulla workflow/set_workflow_status` — Enable/disable a workflow or change its status (draft | production | archive) by id or exact name, then re-arm the scheduler so the change takes effect immediately without an ap...
- `sulla workflow/routines_digest` — Deterministic delta + exceptions-only digest of routine health (zero-LLM to produce, tiny to consume).
- `sulla workflow/routine_report` — Drill-down report for a routine flagged by routines_digest: last-run status, timing, error, and the step-by-step tool-call trace (from workflow_checkpoints) explaining why it di...
- `sulla workflow/find_repeated_tasks` — Promotion detector for routine stewardship: returns operations that have recurred across >= threshold DISTINCT sessions (deterministic shape-signature over the per-action tool l...
- `sulla workflow/display_workflow` — Surface a Postgres-backed routine as a workflow artifact in the chat sidebar.

## function (3 tools)
- `sulla function/list` — List all custom functions stored in Postgres — shows slug, name, runtime, entrypoint, inputs, and outputs for each.
- `sulla function/run` — Load and run a custom function by slug.
- `sulla function/runs` — Query the function_run history.

→ See [`functions/authoring.md`](../functions/authoring.md)

## browser (24 tools)
- `sulla browser/controller` — Graph-bound delegation to Sulla Desktop's in-app Browser for capability-enabled scheduled graphs.
- `sulla browser/tab` — Open, navigate, or close a browser tab.
- `sulla browser/list` — List all open browser tabs with their assetId, URL, title, and status (ready/loading).
- `sulla browser/snapshot` — Re-read page state for an already-open tab.
- `sulla browser/text` — Get the readable text content of a tab with title, URL, and scroll position.
- `sulla browser/form` — Get a map of all visible form field values (inputs, textareas, selects) from a tab.
- `sulla browser/screenshot` — Capture a visual screenshot of a tab.
- `sulla browser/click` — Click a button, link, or interactive element by handle.
- `sulla browser/fill` — Set the value of a form field (input, textarea, select).
- `sulla browser/press_key` — Press a key.
- `sulla browser/scroll` — Scroll a matching element into view using a CSS selector.
- `sulla browser/wait` — Wait for a CSS selector to become visible.
- `sulla browser/click_at` — Click at pixel coordinates using trusted mouse events.
- `sulla browser/type_at` — Click at coordinates to focus an element, then type text using trusted keyboard events.
- `sulla browser/hover` — Move the mouse to coordinates without clicking.
- `sulla browser/eval_js` — Evaluate arbitrary JavaScript in the active browser tab with enhanced diagnostics.
- `sulla browser/manage_cookies` — Read, set, or delete browser cookies.
- `sulla browser/background_browse` — Browse the web in a hidden tab without disrupting the user's visible browser.
- `sulla browser/search_history` — Search the user's browsing history by text query and/or time range.
- `sulla browser/modify_history` — Add, delete, or clear browsing history entries.
- `sulla browser/search_conversations` — Search past chat conversations, browser visits, and workflow executions.
- `sulla browser/agent_storage` — Persistent key-value store for agent state that survives across conversations.
- `sulla browser/monitor_network` — Monitor network requests for a duration.
- `sulla browser/schedule_alarm` — Set, list, or clear named timers.

→ See [`tools/browser.md`](browser.md)

## github (58 tools)
- `sulla github/add_remote` — Add a remote repository to an existing git repository.
- `sulla github/comment_on_issue` — Add a comment to a GitHub issue.
- `sulla github/create_file` — Create a new file in a GitHub repository.
- `sulla github/get_issue` — Get details of a specific GitHub issue.
- `sulla github/get_issue_comments` — Read the comment thread on a GitHub issue or pull request (PRs are issues in the API — pass the PR number).
- `sulla github/get_issues` — Get issues from a GitHub repository.
- `sulla github/heartbeat_new_issues` — Heartbeat issue-discovery (#500) "touched-before" filter: given the open-issue union from scan_active_issues, returns only issues Heartbeat has NOT handled before — anti-joined...
- `sulla github/heartbeat_claim_issue` — Heartbeat issue-discovery (#500) atomic claim + collision guard: records an issue in the heartbeat_seen_issues seen-set via INSERT ...
- `sulla github/list_projects` — List Projects V2 boards for an org or user, with each board's node id (projectId, PVT_…), fields, and — for single-select fields like Status — every option id/name.
- `sulla github/add_issue_to_project` — Add an issue (or PR) as a card on a Projects V2 board via addProjectV2ItemById (GraphQL-only).
- `sulla github/set_project_field` — Set one field on one Projects V2 card via updateProjectV2ItemFieldValue (GraphQL-only) — most often the Status single-select, i.e.
- `sulla github/init` — Initialize a git repository at the specified absolute path.
- `sulla github/list_branches` — List branches in a GitHub repository.
- `sulla github/create_ref` — Create a remote branch (or tag) on GitHub, pointed at an explicit SHA or the current tip of another branch (from_branch).
- `sulla github/delete_ref` — Delete a remote branch (or tag) on GitHub.
- `sulla github/read_file` — Read the contents of a file from a GitHub repository.
- `sulla github/update_file` — Update an existing file in a GitHub repository.
- `sulla github/git_blame` — Show who last modified each line of a file.
- `sulla github/git_pull` — Pull commits from a remote repository.
- `sulla github/git_fetch` — Fetch authenticated remote refs without changing the working tree.
- `sulla github/git_conflicts` — List files with merge conflicts and show the conflict diffs for each file.
- `sulla github/git_add` — Stage files for commit.
- `sulla github/git_commit` — Stage files and create a git commit.
- `sulla github/git_push` — Push commits to a remote repository.
- `sulla github/git_worktree` — Add, list, remove, or prune git worktrees — check out multiple branches of one repo into separate directories at once (ideal for reviewing/building several PRs in parallel).
- `sulla github/create_issue` — Create a new issue in a GitHub repository.
- `sulla github/update_issue` — Update an existing GitHub issue — edit title, body, labels, assignees, or state.
- `sulla github/close_issue` — Close a GitHub issue with an optional reason (completed or not_planned).
- `sulla github/create_pr` — Create a pull request in a GitHub repository.
- `sulla github/ready_pr` — Flip a draft pull request to "ready for review" (draft PRs cannot be merged).
- `sulla github/draft_pr` — Return a ready pull request to draft via the GraphQL convertPullRequestToDraft mutation (the inverse of github_ready_pr; REST cannot do this).
- `sulla github/merge_pr` — Merge a GitHub pull request.
- `sulla github/create_release` — Cut a GitHub release (and its git tag).
- `sulla github/check_runs` — List CI check runs for a ref (branch name, SHA, or tag).
- `sulla github/ci_logs` — Inspect CI failures by workflow run, Actions job, or ref.
- `sulla github/claim_files` — Claim repository-relative file globs for a worker.
- `sulla github/release_files` — Release active file claims in one repository by owner label or explicit claim ids.
- `sulla github/list_claims` — List active worker file claims, optionally scoped to the repository containing absolutePath.
- `sulla github/trigger_workflow_run` — Manually trigger a GitHub Actions workflow via workflow_dispatch.
- `sulla github/git_branch` — Create, switch, delete, or list git branches.
- `sulla github/git_status` — Show the working tree status — current branch, staged/unstaged/untracked files.
- `sulla github/git_log` — Show commit history for a repository.
- `sulla github/git_diff` — Show changes between working tree, staging area, or commits.
- `sulla github/git_stash` — Save, list, apply, pop, or drop stashed changes.
- `sulla github/git_checkout` — Restore files from a commit or branch, or discard working tree changes.
- `sulla github/create_repo` — Create a new GitHub repository for the authenticated user or an organization.
- `sulla github/get_repo` — Get metadata and stats for a GitHub repository — stars, forks, language, topics, default branch, license, push times.
- `sulla github/list_repos` — List repositories for the authenticated user, a specific user, or an organization.
- `sulla github/delete_repo` — Permanently delete a GitHub repository.
- `sulla github/fork_repo` — Fork a GitHub repository into the authenticated user's account or a specified organization.
- `sulla github/get_pr` — Get full details of a specific pull request — head/base, diff stats, reviewer list, labels, mergeable state.
- `sulla github/list_prs` — List one page of pull requests with optional filters.
- `sulla github/update_pr` — Edit a pull request — update its title, body, base branch, or open/closed state.
- `sulla github/close_pr` — Close a pull request without merging it.
- `sulla github/add_pr_review` — Submit a pull request review — APPROVE, REQUEST_CHANGES, or COMMENT.
- `sulla github/list_pr_reviews` — List all reviews on a pull request with their state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED) and authors.
- `sulla github/request_pr_reviewers` — Request specific users or teams to review a pull request.
- `sulla github/get_pr_files` — List all files changed in a pull request with their status (added/modified/removed/renamed) and line diff counts.

→ See [`tools/github.md`](github.md)

## chat (18 tools)
- `sulla chat/launch_agent_tab` — Alias of meta/spawn_agent with visibility "tab": launch an enabled agent in its own visible chat tab with a return contract.
- `sulla chat/return_contract` — Alias of agents/return_result: return your contract to the agent that launched you.
- `sulla chat/message_tab` — Alias of agents/send_job_message addressed by contract id or child thread id: send a follow-up to one of this chat's open children.
- `sulla chat/list_tab_contracts` — Alias view of agents/check_agent_jobs for this chat's tab children, in the old contract shape (status open/returned/cancelled, returned results).
- `sulla chat/route_agent` — Select an enabled agent persona for a chat.
- `sulla chat/set_heartbeat` — Set the heartbeat for the current chat tab only.
- `sulla chat/artifact_list` — List sidebar artifacts for this chat.
- `sulla chat/artifact_create` — Create and focus a sidebar artifact for this chat.
- `sulla chat/artifact_read` — Read current artifact content and version, including edits or checkbox ticks made by the human.
- `sulla chat/artifact_update` — Replace an artifact content and/or rename or change its status.
- `sulla chat/artifact_edit` — Apply exact find/replace edits atomically to an existing artifact.
- `sulla chat/artifact_append` — Append text to an existing sidebar artifact, such as a notes or progress log section.
- `sulla chat/artifact_focus` — Focus an existing open sidebar artifact without changing its content or version.
- `sulla chat/artifact_close` — Close an artifact sidebar tab while preserving its content and revision history.
- `sulla chat/artifact_reopen` — Reopen and focus a previously closed artifact in this chat.
- `sulla chat/artifact_delete` — Soft-delete an artifact while retaining its database revision history.
- `sulla chat/artifact_history` — Read every saved revision of an artifact, newest first, including whether the agent or human made it.
- `sulla chat/artifact_revert` — Restore an artifact content from an earlier version as a new revision, preserving all history.

## pg (6 tools)
- `sulla pg/count` — Execute a PostgreSQL count query and return the count.
- `sulla pg/execute` — Execute a PostgreSQL statement and return execution results.
- `sulla pg/query` — Execute a PostgreSQL query and return results.
- `sulla pg/queryall` — Execute a PostgreSQL query and return all result rows.
- `sulla pg/queryone` — Execute a PostgreSQL query and return the first result row.
- `sulla pg/transaction` — Execute multiple PostgreSQL statements in a transaction.

## redis (12 tools)
- `sulla redis/decr` — Decrement the integer value of a Redis key by one.
- `sulla redis/del` — Delete one or more Redis keys.
- `sulla redis/expire` — Set a timeout on a Redis key.
- `sulla redis/get` — Get the value of a Redis key.
- `sulla redis/hget` — Get the value of a field in a Redis hash.
- `sulla redis/hgetall` — Get all fields and values from a Redis hash.
- `sulla redis/hset` — Set the value of a field in a Redis hash.
- `sulla redis/incr` — Increment the integer value of a Redis key by one.
- `sulla redis/lpop` — Remove and return the first element of a Redis list.
- `sulla redis/rpush` — Append one or more values to a Redis list.
- `sulla redis/set` — Set the value of a Redis key.
- `sulla redis/ttl` — Get the time to live (TTL) of a Redis key.

## settings (2 tools)
- `sulla settings/get` — Read a Sulla Desktop setting through SullaSettingsModel (Redis cache → Postgres → file fallback).
- `sulla settings/set` — Write a Sulla Desktop setting through SullaSettingsModel so Postgres and the Redis cache stay in sync.

## vault (10 tools)
- `sulla vault/read_secrets` — Retrieve the credentials and connection status for a specific integration.
- `sulla vault/is_enabled` — Check whether a specific integration is enabled (connected).
- `sulla vault/list_accounts` — List all accounts configured for an integration.
- `sulla vault/set_active_account` — Set which account is active for an integration.
- `sulla vault/set_credential` — Store or update a credential for an integration account.
- `sulla vault/list` — List website credentials only; API keys use list_api_keys.
- `sulla vault/list_api_keys` — List API key/Login items this agent may use through owner-declared proxy rules; no secrets.
- `sulla vault/request` — Request an allowed HTTPS API using an item id or exact name, without exposing credentials.
- `sulla vault/autofill` — Autofill a login form on the active browser tab, or an explicitly requested background tab, with saved vault credentials.
- `sulla vault/delete_credential` — Delete a single credential property from the vault.

## calendar (7 tools)
- `sulla calendar/cancel` — Cancel a calendar event by ID.
- `sulla calendar/create` — Create a new calendar event or reminder.
- `sulla calendar/delete` — Delete a calendar event by ID.
- `sulla calendar/get` — Get details of a specific calendar event by ID.
- `sulla calendar/list` — List calendar events within a date range.
- `sulla calendar/list_upcoming` — List upcoming calendar events for the next specified number of days.
- `sulla calendar/update` — Update an existing calendar event.

→ See [`tools/calendar.md`](calendar.md)

## notify (2 tools)
- `sulla notify/user` — Send a notification to the user.
- `sulla notify/history` — Read the notification history.

## bridge (2 tools)
- `sulla bridge/update_human_presence` — Update the human presence state in Redis.
- `sulla bridge/get_human_presence` — Read the current human presence state from Redis.

## slack (7 tools)
- `sulla slack/connection_health` — Check Slack integration health and auto-reinitialize if disconnected/unhealthy.
- `sulla slack/search_users` — Search Slack users by username, real name, display name, or email.
- `sulla slack/send_message` — Send a new message to a Slack channel.
- `sulla slack/thread` — Get replies in a Slack thread.
- `sulla slack/unreact` — Remove a reaction emoji from a Slack message.
- `sulla slack/update` — Update an existing Slack message.
- `sulla slack/user` — Get information about a Slack user.

## gdrive (4 tools)
- `sulla gdrive/list_folder` — List what is inside a Google Drive folder (Docs, Sheets, Slides, PDFs, images, videos, subfolders).
- `sulla gdrive/search` — Search Google Drive by file name and full text.
- `sulla gdrive/read` — Read a Drive file as text: Google Docs as Markdown, Sheets as CSV (first tab), Slides as plain text, and plain text/JSON/CSV files as-is.
- `sulla gdrive/download` — Save a Drive file to local disk (default ~/sulla/cache/gdrive/) and return the path, so PDFs, images and videos can be read or viewed.

→ See [`tools/gdrive.md`](gdrive.md)

## mobile (1 tool)
- `sulla mobile/list_devices` — List every desktop and mobile device registered to the contractor, annotated with online/offline status.



## ledger (1 tools)
- `sulla ledger/scoreboard` — Deterministic outcome-ledger scoreboard (zero LLM): outcomes shipped in the window, WORKING items and how many are staged at a gate, unilateral actions logged in AUDIT.md, and a...

→ See [`tools/ledger.md`](ledger.md)

## models (3 tools)
- `sulla models/providers` — List AI model providers, whether each is connected/on or disconnected/off, whether any required CLI is installed in the Sulla VM, and whether Sulla can use it.
- `sulla models/list` — List models available for one provider using Sulla provider discovery, with static catalog fallback when live discovery is unavailable.
- `sulla models/usage` — Read locally tracked usage, API-equivalent cost estimates, model breakdowns, trends, and the latest subscription limit windows emitted by provider CLIs.

## applescript (5 tools)
- `sulla applescript/execute` — Execute AppleScript to interact with macOS applications (Calendar, Reminders, Mail, Notes, Safari, Finder, Music, and more).
- `sulla applescript/computer_use_list` — List every AppleScript-reachable app the Computer Use Settings window exposes, grouped by category, annotated with current enabled/disabled state (✓ = enabled).
- `sulla applescript/computer_use_enable` — Explicitly enable an AppleScript target in Computer Use Settings.
- `sulla applescript/computer_use_disable` — Flip off a Computer Use Settings target.
- `sulla applescript/audit_log` — Read the AppleScript execution audit log.

→ See [`tools/applescript.md`](applescript.md), [`tools/computer-use.md`](computer-use.md)

## capture (19 tools)
- `sulla capture/teleprompter_open` — Open the floating teleprompter window (transparent, always-on-top, positioned near the webcam at top-center of the active display).
- `sulla capture/teleprompter_close` — Close the floating teleprompter window.
- `sulla capture/teleprompter_status` — Return whether the floating teleprompter window is currently open.
- `sulla capture/teleprompter_script` — Push script text to the teleprompter.
- `sulla capture/teleprompter_style` — Update the teleprompter visual style (font size and/or highlight color).
- `sulla capture/mic_start` — Start the microphone capture driver.
- `sulla capture/mic_stop` — Release this agent's hold on the microphone capture driver.
- `sulla capture/speaker_start` — Prepare system-audio capture using Electron native loopback (ScreenCaptureKit on macOS 13+), with BlackHole only as a fallback.
- `sulla capture/speaker_stop` — Release Capture Studio's native or fallback speaker-loopback source.
- `sulla capture/audio_state` — Report whether mic and speaker capture are currently running and which devices they're bound to.
- `sulla capture/list_screens` — Enumerate capturable displays and/or application windows via Electron's desktopCapturer.
- `sulla capture/recorder_start` — Start a recording session.
- `sulla capture/recorder_stop` — Stop the active recording session.
- `sulla capture/recorder_status` — Report whether a recording is active, along with elapsed seconds, bytes written, current session directory, and any last error.
- `sulla capture/camera_list` — Enumerate video input devices (webcams, capture cards) visible to the Capture Studio renderer.
- `sulla capture/camera_set` — Acquire a camera stream in Capture Studio.
- `sulla capture/camera_release` — Stop and release the current camera stream in Capture Studio.
- `sulla capture/screen_set` — Acquire a screen/window capture stream in Capture Studio by sourceId (from capture/list_screens).
- `sulla capture/quality_set` — Set the recording quality preset for either the screen or camera stream (480p | 720p | 1080p | 4k | auto).

→ See [`tools/capture.md`](capture.md), [`desktop/capture-studio.md`](../desktop/capture-studio.md)

## ui (1 tools)
- `sulla ui/open_tab` — Open or focus a built-in Sulla Desktop view (Use Cases, vault, integrations, routines, history, secretary, chat, document, browser, projects, files, agents, decide) or settings...

## marketplace (11 tools)
- `sulla marketplace/search` — Search the whole Sulla Marketplace catalog.
- `sulla marketplace/info` — Full details for one marketplace listing by kind + slug: template id, version, author, category, tags, downloads, manifest metadata and kind summary, and local install status.
- `sulla marketplace/download` — Install a marketplace listing using the same database installer as the Use Cases tab.
- `sulla marketplace/scaffold` — Generate a new artifact directory locally with a kind-appropriate skeleton (manifest + handler / soul / compose / etc.).
- `sulla marketplace/validate` — Validate a locally-installed artifact against its kind-specific schema.
- `sulla marketplace/publish` — Submit a local artifact to the Sulla Marketplace using the Library publish pipeline.
- `sulla marketplace/unpublish` — Take down your own marketplace submission for kind + slug: approved listings are withdrawn (kept in your submissions as rejected), pending ones are deleted.
- `sulla marketplace/list_local` — List local artifacts from Postgres, with existing user-owned folders included as a legacy fallback.
- `sulla marketplace/list_published` — List everything you have submitted to the marketplace with its review status (pending / live / rejected), download count, and reviewer notes.
- `sulla marketplace/update` — Update an installed marketplace artifact to the latest version, replacing the local copy in place (restored if the update fails).
- `sulla marketplace/diff` — Show files only in the marketplace, only local, or differing between your installed copy and the latest marketplace version.

→ See [`tools/marketplace.md`](marketplace.md)

## skills (4 tools)
- `sulla skills/skill_list` — List the skills in the database (slug, title, source, enabled, triggers).
- `sulla skills/skill_get` — Load one skill from the database: its full SKILL.md (frontmatter + body) and the list of its extra files.
- `sulla skills/skill_save` — Create or update a skill in the database from SKILL.md text: a YAML frontmatter block (slug, title, tags, triggers, ...) followed by the markdown body.
- `sulla skills/skill_disable` — Disable, re-enable, or soft-delete a skill in the database.

## extensions (7 tools)
- `sulla extensions/list_extension_catalog` — List all available extensions from the Sulla marketplace catalog.
- `sulla extensions/list_installed_extensions` — List all currently installed extensions with their versions, URLs, and upgrade status.
- `sulla extensions/install_extension` — Install an extension from the marketplace.
- `sulla extensions/uninstall_extension` — Uninstall an installed extension.
- `sulla extensions/start_extension` — Start a previously-installed extension (recipe).
- `sulla extensions/stop_extension` — Stop a running extension (recipe).
- `sulla extensions/get_extension_status` — Check whether an extension is running, stopped, or not installed.

## docker (9 tools)
- `sulla docker/build` — Build a Docker image from a Dockerfile.
- `sulla docker/exec` — Execute a command in a running Docker container.
- `sulla docker/images` — List Docker images.
- `sulla docker/logs` — Fetch the logs of a Docker container.
- `sulla docker/ps` — List Docker containers.
- `sulla docker/pull` — Pull a Docker image from a registry.
- `sulla docker/rm` — Remove one or more Docker containers.
- `sulla docker/run` — Run a Docker container.
- `sulla docker/stop` — Stop a running Docker container.

## kubectl (3 tools)
- `sulla kubectl/apply` — Apply a Kubernetes manifest file.
- `sulla kubectl/delete` — Delete Kubernetes resources.
- `sulla kubectl/describe` — Describe Kubernetes resources.

## secretary (3 tools)
- `sulla secretary/start` — Start Secretary Mode — opens (or focuses) a Secretary tab and auto-begins the listening session.
- `sulla secretary/stop` — Stop Secretary Mode — ends the active listening session.
- `sulla secretary/status` — Check whether Secretary Mode is currently listening.

## bookmarks (7 tools)
- `sulla bookmarks/list` — List bookmarks from the app Bookmarks pane as a nested tree or as the direct children of one folder.
- `sulla bookmarks/search` — Search bookmark and folder titles and bookmark URLs.
- `sulla bookmarks/add` — Save a useful link, research source, dashboard, deploy URL, artifact, or other agent-owned item in the app Bookmarks pane.
- `sulla bookmarks/create_folder` — Create a folder in the app Bookmarks pane to organize links and agent-owned items.
- `sulla bookmarks/update` — Rename a bookmark or folder, or change a bookmark URL in the app Bookmarks pane.
- `sulla bookmarks/move` — Move or reorder a bookmark or folder in the app Bookmarks pane.
- `sulla bookmarks/remove` — Remove a bookmark or folder from the app Bookmarks pane.

## files (10 tools)
- `sulla files/where` — Find the best described folder before saving. Returns ranked folders plus a suggested folder and filename.
- `sulla files/create_folder` — Create a folder when no described folder fits. `description` is required.
- `sulla files/history` — List every version of a Sulla file.
- `sulla files/versions` — List versions with publication, lock, and retention state.
- `sulla files/request_publish` — Ask for human approval to publish a draft version. Returns at once; the decision appears in Decide. Agents cannot publish directly.
- `sulla files/restore` — Restore an older file version as a new current version.
- `sulla files/link` — Create a public Sulla Cloud share link for a file or folder.
- `sulla files/shared` — List public links shared by the signed-in user, including views, expiry, keep-available state, source and revocation.
- `sulla files/revoke_link` — Revoke a public share link and remove any temporary Cloud copy.
- `sulla files/search` — Hybrid search over files the launching person can access.

## reflex (7 tools)
- `sulla reflex/teach` — Teach the Reflex engine what to do for a user message: map an utterance to ONE Sulla tool call (tool + params) that fully satisfies it, or to tool "none" for messages that shoul...
- `sulla reflex/predict` — Dry-run the Reflex engine on a message: returns the tool/params it would pick, its confidence, the current threshold, whether it would act, and the nearest training examples.
- `sulla reflex/correct` — Tell the Reflex engine one of its decisions was wrong.
- `sulla reflex/list_examples` — List Reflex training examples, newest first.
- `sulla reflex/forget` — Forget (soft-archive) a Reflex training example by id.
- `sulla reflex/stats` — Reflex engine status: enabled flag, confidence threshold, allowed categories, example counts, decision counts by outcome, corrections, and the most recent decisions.
- `sulla reflex/export` — Export the active Reflex training set as JSON ({version, examples:[{utterance, tool, params, positive}]}) so it can be reviewed or shipped as a production seed.

## rules (4 tools)
- `sulla rules/list_rules` — List active user-created rules from the rules table, most severe first then recency.
- `sulla rules/search_rules` — Search user-created rules by keyword or phrase across title + content.
- `sulla rules/add_rule` — Add or update a user-created rule the Security Conscience should enforce (e.g.
- `sulla rules/archive_rule` — Archive (soft-delete) a user-created rule by its id.

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
Account IDs are discoverable via `sulla vault/list_accounts '{"account_type":"<slug>"}'`. Credentials are auto-injected — the agent never handles raw tokens. Third-party tools (e.g. Twenty CRM) install as **recipes** (extensions) and are reached via this proxy after install.

---

## Summary counts (live catalog, 2026-10-19)

| Category | Tools | | Category | Tools |
|----------|------:|-|----------|------:|
| github | 58 | | bookmarks | 7 |
| project | 34 | | reflex | 7 |
| browser | 24 | | pg | 6 |
| capture | 19 | |
| chat | 18 | | mobile | 5 |
| observation | 12 | | applescript | 5 |
| redis | 12 | | gdrive | 4 |
| meta | 11 | | skills | 4 |
| agents | 11 | | rules | 4 |
| marketplace | 11 | | function | 3 |
| models | 3 |
| files | 14 | | kubectl | 3 |
| memory | 9 | | secretary | 3 |
| docker | 9 | | settings | 2 |
| workflow | 8 | | notify | 2 |
| vault | 8 | | bridge | 2 |
| calendar | 7 | | ledger | 1 |
| slack | 7 | | ui | 1 |
| extensions | 7 | | | |
| | | | **Total** | **353** |


Projects are plain files. See [Projects in Files](../environment/projects-in-files.md).
