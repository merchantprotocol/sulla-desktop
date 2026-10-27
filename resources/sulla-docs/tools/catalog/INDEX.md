# Live tool catalog

Generated from the live Sulla tool catalog. Each line is `category/tool — description`.

agents/check_agent_jobs — Inspect delegated jobs (hidden and tab), including visibility, contract, per-task elapsed time, latest and recent check-ins, blockers, touched files, and undelivered orchestrator-message counts.
agents/close_agent_conversation — Close a sub-agent conversation and free its resources (drops the sub-agent's graph + state). Do this when you're done talking to a sub-agent.
agents/directory — Directory of every callable custom agent (from agent_definitions) as compact cards: when to call it, when not to, what to send, what it returns, cost tier, and which agents it can call. Use it to pick the right specialist before spawn_agent.
agents/list_agents — List the live named agents you can message (heartbeat, mobile-relay, other frontends) with their channel, status, and uptime — the roster from turn context, queryable on demand. Message any with a <channel:CHANNEL>text</channel:CHANNEL> tag (fire-and-forget; the reply arrives on a later turn).
agents/read_agent_conversation — Read the transcript of an open sub-agent conversation, or list all open conversations when called without a conversationId.
agents/report_progress — Record a milestone check-in for your current delegated task (hidden worker or agent tab). Call it at meaningful milestones and at least every ~5 minutes; your parent sees it in its subagent directory.
agents/return_result — Finish your delegated task by returning its contract to the agent that launched you (hidden worker or agent tab). The result is checked against the contract in your brief; a mismatch is refused so you can fix it.
agents/send_agent_message — DEPRECATED conversation compatibility surface. For a running spawn_agent job, use send_job_message with its jobId instead.
agents/send_job_message — Send new direction to one or all running tasks in a delegated job, hidden or tab. Hidden workers get it live when possible, otherwise at their next model-call boundary; a tab child gets it in its chat (steers a live turn or starts one).
agents/start_agent_conversation — DEPRECATED compatibility wrapper over spawn_agent. Launches one async job and returns jobId plus a conversationId alias.
agents/stop_agent_job — Kill switch for a running delegated job, hidden or tab. Hidden: fires the job's abort signal, which cascades to every sub-agent it spawned, unwinding them cooperatively (an in-flight LLM/tool call finishes first).
applescript/audit_log — Read the AppleScript execution audit log. Every applescript_execute call writes a row with target_app, script, success, duration, and error.
applescript/execute — Execute AppleScript to interact with macOS applications (Calendar, Reminders, Mail, Notes, Safari, Finder, Music, and more). Always specify the target app name.
bookmarks/add — Save a useful link, research source, dashboard, deploy URL, artifact, or other agent-owned item in the app Bookmarks pane. Defaults to a root Sulla folder and avoids duplicate URLs within the destination folder.
bookmarks/create_folder — Create a folder in the app Bookmarks pane to organize links and agent-owned items.
bookmarks/list — List bookmarks from the app Bookmarks pane as a nested tree or as the direct children of one folder. Returns bookmark metadata without favicon blobs.
bookmarks/move — Move or reorder a bookmark or folder in the app Bookmarks pane.
bookmarks/remove — Remove a bookmark or folder from the app Bookmarks pane. Non-empty folders require recursive: true and are removed with all descendants.
bookmarks/search — Search bookmark and folder titles and bookmark URLs. Use this to find saved research sources, dashboards, deploy URLs, and agent-owned items.
bookmarks/update — Rename a bookmark or folder, or change a bookmark URL in the app Bookmarks pane.
bridge/get_human_presence — Read the current human presence state from Redis. Returns whether the human is available, what they are viewing, their activity, and how long since they were last seen.
bridge/update_human_presence — Update the human presence state in Redis. Call this to inform other agents about what the human is currently viewing, doing, or whether they are available.
browser/agent_storage — Persistent key-value store for agent state that survives across conversations. Store task progress, discovered user preferences, cached API responses, or any structured data.
browser/background_browse — Browse the web in a hidden tab without disrupting the user's visible browser. Open pages, read content, capture screenshots, navigate, and close — all in the background.
browser/click — Click a button, link, or interactive element by handle. Handles come from the snapshot returned by browser/tab (upsert) or browser/snapshot — e.g. @btn-save, @link-home.
browser/click_at — Click at pixel coordinates using trusted mouse events. Use `browser/screenshot` first to identify coordinates (grid on by default).
browser/controller — Graph-bound delegation to Sulla Desktop's in-app Browser for capability-enabled scheduled graphs. Read the installed Browser skill safety rules and bundled tools/browser.md first, then pass one browser operation plus its documented arguments.
browser/eval_js — Evaluate arbitrary JavaScript in the active browser tab with enhanced diagnostics. A single expression is auto-returned like a devtools console (`document.title` works as-is); multi-statement code must use an explicit `return` to send a value back.
browser/fill — Set the value of a form field (input, textarea, select). If submit=true, presses Enter after to submit the form; if that triggers navigation, returns the full new page state.
browser/form — Get a map of all visible form field values (inputs, textareas, selects) from a tab.
browser/hover — Move the mouse to coordinates without clicking. Triggers hover effects, dropdown menus, and tooltips.
browser/list — List all open browser tabs with their assetId, URL, title, and status (ready/loading).
browser/manage_cookies — Read, set, or delete browser cookies. Use to debug auth issues, check login state, inspect session tokens, or manage cookies across integrated services (Twenty CRM, N8N, etc.).
browser/modify_history — Add, delete, or clear browsing history entries. Use to record researched URLs, remove sensitive entries, or clear history for privacy.
browser/monitor_network — Monitor network requests for a duration. Capture all requests (with status codes) or watch for errors/failures.
browser/press_key — Press a key. Use for form submission (Enter), closing dialogs (Escape), navigating dropdowns (ArrowDown/ArrowUp), or tabbing between fields (Tab).
browser/schedule_alarm — Set, list, or clear named timers. Use for deferred checks ("check the deploy in 5 minutes"), periodic polling, or simple reminders.
browser/screenshot — Capture a visual screenshot of a tab. Image is saved to disk and the response returns a compact `{ screenshot: { assetId, path, width, height, bytes } }` reference — never inline base64.
browser/scroll — Scroll a matching element into view using a CSS selector.
browser/search_conversations — Search past chat conversations, browser visits, and workflow executions. Find previous discussions by keyword, list recent activity, retrieve details, or read the full transcript of a past conversation.
browser/search_history — Search the user's browsing history by text query and/or time range. Find pages visited previously, check when a site was last accessed, or recall URLs the user looked at earlier.
browser/snapshot — Re-read page state for an already-open tab. Default "dehydrated" mode returns a compressed DOM tree (~5k tokens) with interactive-element handles — ideal for planning. "full" mode adds reader-mode text and scroll position.
browser/tab — Open, navigate, or close a browser tab. When opening/navigating (action=upsert), the response already includes a dehydrated DOM snapshot of the loaded page — title, URL, interactive elements, and a summary — so you do NOT need to call `browser/snapshot` separately afterwards.
browser/text — Get the readable text content of a tab with title, URL, and scroll position. Uses reader-mode extraction (strips nav, ads, boilerplate) with fallback to raw text.
browser/type_at — Click at coordinates to focus an element, then type text using trusted keyboard events. After typing, captures a screenshot.
browser/wait — Wait for a CSS selector to become visible. Useful after clicking a button to wait for new content to appear.
calendar/cancel — Cancel a calendar event by ID.
calendar/create — Create a new calendar event or reminder.
calendar/delete — Delete a calendar event by ID.
calendar/get — Get details of a specific calendar event by ID.
calendar/list — List calendar events within a date range.
calendar/list_upcoming — List upcoming calendar events for the next specified number of days.
calendar/update — Update an existing calendar event.
capture/audio_state — Report whether mic and speaker capture are currently running and which devices they're bound to.
capture/camera_list — Enumerate video input devices (webcams, capture cards) visible to the Capture Studio renderer. Returns { deviceId, label } pairs.
capture/camera_release — Stop and release the current camera stream in Capture Studio.
capture/camera_set — Acquire a camera stream in Capture Studio. Without deviceId, uses the first available camera.
capture/list_screens — Enumerate capturable displays and/or application windows via Electron's desktopCapturer. Returns { id, name } pairs the agent can pass to capture/screenshot.
capture/mic_start — Start the microphone capture driver. On macOS, proactively requests microphone permission.
capture/mic_stop — Release this agent's hold on the microphone capture driver. Capture only stops fully when every service has released.
capture/quality_set — Set the recording quality preset for either the screen or camera stream (480p | 720p | 1080p | 4k | auto). Affects bitrate on the next recorder_start.
capture/recorder_start — Start a recording session. Auto-opens Capture Studio and — when the streams aren't already acquired — auto-acquires whatever sources you ask for.
capture/recorder_status — Report whether a recording is active, along with elapsed seconds, bytes written, current session directory, and any last error. Does NOT open Capture Studio just to answer this query — returns "idle" when Capture Studio isn't running.
capture/recorder_stop — Stop the active recording session. Writes manifest.json to the session directory.
capture/screen_set — Acquire a screen/window capture stream in Capture Studio by sourceId (from capture/list_screens). This is what the agent calls when it wants the recorder to include that display.
capture/speaker_start — Prepare system-audio capture using Electron native loopback (ScreenCaptureKit on macOS 13+), with BlackHole only as a fallback. Auto-opens Capture Studio.
capture/speaker_stop — Release Capture Studio's native or fallback speaker-loopback source.
capture/teleprompter_close — Close the floating teleprompter window. No-op if it is already closed.
capture/teleprompter_open — Open the floating teleprompter window (transparent, always-on-top, positioned near the webcam at top-center of the active display). Safe to call when it is already open.
capture/teleprompter_script — Push script text to the teleprompter. Splits on whitespace into words so the prompter can highlight the current word.
capture/teleprompter_status — Return whether the floating teleprompter window is currently open.
capture/teleprompter_style — Update the teleprompter visual style (font size and/or highlight color). Requires the teleprompter to be open.
chat/artifact_append — Append text to an existing sidebar artifact, such as a notes or progress log section.
chat/artifact_close — Close an artifact sidebar tab while preserving its content and revision history.
chat/artifact_create — Create and focus a sidebar artifact for this chat. If its name already exists, updates that same artifact instead of opening a duplicate.
chat/artifact_delete — Soft-delete an artifact while retaining its database revision history. Requires confirm: true.
chat/artifact_edit — Apply exact find/replace edits atomically to an existing artifact. Every find must occur exactly once or nothing changes.
chat/artifact_focus — Focus an existing open sidebar artifact without changing its content or version.
chat/artifact_history — Read every saved revision of an artifact, newest first, including whether the agent or human made it.
chat/artifact_list — List sidebar artifacts for this chat. Plans and working docs should live in ONE named artifact that you keep updating in place.
chat/artifact_open — Open an existing Sulla Files file in this chat artifact sidebar. Edits save back to the same versioned file with conflict protection.
chat/artifact_read — Read current artifact content and version, including edits or checkbox ticks made by the human. Always read before editing a shared plan.
chat/artifact_reopen — Reopen and focus a previously closed artifact in this chat.
chat/artifact_revert — Restore an artifact content from an earlier version as a new revision, preserving all history.
chat/artifact_update — Replace an artifact content and/or rename or change its status. Updates the existing sidebar tab in place; do not create a new copy of a plan.
chat/launch_agent_tab — Alias of meta/spawn_agent with visibility "tab": launch an enabled agent in its own visible chat tab with a return contract. Prefer spawn_agent with visibility "tab".
chat/list_tab_contracts — Alias view of agents/check_agent_jobs for this chat's tab children, in the old contract shape (status open/returned/cancelled, returned results).
chat/message_tab — Alias of agents/send_job_message addressed by contract id or child thread id: send a follow-up to one of this chat's open children. Steers a running child or starts a new turn when idle.
chat/return_contract — Alias of agents/return_result: return your contract to the agent that launched you. Only the child thread that owns the contract may call this; schema mismatches are rejected.
chat/route_agent — Select an enabled agent persona for a chat. Reflex uses this as a training target for first-message routing; it is not executed by the normal mid-chat Reflex action engine.
chat/set_heartbeat — Set the heartbeat for the current chat tab only. Use intervalMinutes=0 to turn it off.
docker/build — Build a Docker image from a Dockerfile.
docker/exec — Execute a command in a running Docker container.
docker/images — List Docker images.
docker/logs — Fetch the logs of a Docker container.
docker/ps — List Docker containers.
docker/pull — Pull a Docker image from a registry.
docker/rm — Remove one or more Docker containers.
docker/run — Run a Docker container.
docker/stop — Stop a running Docker container.
extensions/get_extension_status — Check whether an extension is running, stopped, or not installed. Use before start/stop to avoid surprises.
extensions/install_extension — Install an extension from the marketplace. Provide the extension ID in slug:version format (e.g. "docker.io/merchantprotocol/stirling-pdf:2026.02").
extensions/list_extension_catalog — List all available extensions from the Sulla marketplace catalog. Optionally filter by category or search query.
extensions/list_installed_extensions — List all currently installed extensions with their versions, URLs, and upgrade status.
extensions/start_extension — Start a previously-installed extension (recipe). The container stack comes back up; web UIs and integrations become reachable again.
extensions/stop_extension — Stop a running extension (recipe). Container stack goes down — web UI and integrations stop responding.
extensions/uninstall_extension — Uninstall an installed extension. By default preserves the data/ directory so user data survives reinstall.
files/collections — List the Files collections the launching person can see in the File Manager, with ids and roles.
files/create_folder — Create a Files folder when no described folder fits. Agents must explain the folder purpose.
files/history — List every version of a Sulla file.
files/link — Create a public Sulla Cloud share link for a file or folder. Captures default to a temporary Cloud copy; ordinary files default to Desktop pass-through.
files/list — List files in a collection exactly as the File Manager loads them. Optional path prefix, trash, and limit (default 200).
files/request_publish — Request human approval to publish a draft file version. Returns immediately.
files/restore — Restore an older file version as a new current version.
files/revoke_link — Revoke a public share link and remove any temporary Cloud copy.
files/search — Hybrid search over files the launching person can access. Supports folder, type, person, and date filters; accepts an optional absolute path prefix; omit it to search all accessible files.
files/shared — List public links shared by the signed-in user, including views, expiry, keep-available state, source and revocation.
files/versions — List versions with publication, lock, and retention state.
files/where — Find the best described Files folder before saving. Returns ranked folders plus a suggested folder and filename.
function/list — List all custom functions stored in Postgres — shows slug, name, runtime, entrypoint, inputs, and outputs for each.
function/run — Load and run a custom function by slug. Returns the full execution trace: function metadata, runtime details, load status, inputs used, and all outputs — everything in one call.
function/runs — Query the function_run history. Every function_run call writes a row with slug, runtime, inputs/outputs, success, error_stage, duration.
gdrive/download — Save a Drive file to local disk (default ~/sulla/cache/gdrive/) and return the path, so PDFs, images and videos can be read or viewed. Google Docs/Sheets/Slides are exported (default pdf/xlsx/pdf; override with format).
gdrive/list_folder — List what is inside a Google Drive folder (Docs, Sheets, Slides, PDFs, images, videos, subfolders). Accepts a folder id or any drive.google.com folder URL.
gdrive/read — Read a Drive file as text: Google Docs as Markdown, Sheets as CSV (first tab), Slides as plain text, and plain text/JSON/CSV files as-is. Accepts a file id or any Docs/Sheets/Slides/Drive URL.
gdrive/search — Search Google Drive by file name and full text. Optionally limit to one folder or MIME type, or pass raw Drive query syntax in q.
github/add_issue_to_project — Add an issue (or PR) as a card on a Projects V2 board via addProjectV2ItemById (GraphQL-only). Address the board by project_id (PVT_… from github_list_projects) and the issue by content_node_id, or supply owner + repo + issue_number to resolve it.
github/add_pr_review — Submit a pull request review — APPROVE, REQUEST_CHANGES, or COMMENT. Body is required for REQUEST_CHANGES and COMMENT.
github/add_remote — Add a remote repository to an existing git repository.
github/check_runs — List CI check runs for a ref (branch name, SHA, or tag). Use this to answer "is CI green?" — shows status / conclusion / timing for each check.
github/ci_logs — Inspect CI failures by workflow run, Actions job, or ref. Returns check annotations and a bounded job-log excerpt around each failure.
github/claim_files — Claim repository-relative file globs for a worker. Claims are shared across every worktree of the same repository and warn rather than block.
github/close_issue — Close a GitHub issue with an optional reason (completed or not_planned).
github/close_pr — Close a pull request without merging it. Requires confirm:true.
github/comment_on_issue — Add a comment to a GitHub issue.
github/create_file — Create a new file in a GitHub repository.
github/create_issue — Create a new issue in a GitHub repository.
github/create_pr — Create a pull request in a GitHub repository.
github/create_ref — Create a remote branch (or tag) on GitHub, pointed at an explicit SHA or the current tip of another branch (from_branch). Completes remote-branch lifecycle with github_list_branches / github_delete_ref.
github/create_release — Cut a GitHub release (and its git tag). Publishing a non-draft release is outward-facing — refuses without {"confirm":true}; use {"draft":true} for a safe draft.
github/create_repo — Create a new GitHub repository for the authenticated user or an organization.
github/delete_ref — Delete a remote branch (or tag) on GitHub. Destructive + outward-facing — refuses without {"confirm":true}; reports the deleted SHA so it can be restored via github_create_ref.
github/delete_repo — Permanently delete a GitHub repository. Irreversible — requires confirm:true AND confirm_name matching the repo name.
github/draft_pr — Return a ready pull request to draft via the GraphQL convertPullRequestToDraft mutation (the inverse of github_ready_pr; REST cannot do this). Requires a "comment" saying what needs to be fixed — the comment is posted before the conversion so a PR never leaves the ready queue unexplained.
github/fork_repo — Fork a GitHub repository into the authenticated user's account or a specified organization.
github/get_issue — Get details of a specific GitHub issue.
github/get_issue_comments — Read the comment thread on a GitHub issue or pull request (PRs are issues in the API — pass the PR number). Returns each comment with author, association, timestamp, and body.
github/get_issues — Get issues from a GitHub repository.
github/get_pr — Get full details of a specific pull request — head/base, diff stats, reviewer list, labels, mergeable state.
github/get_pr_files — List all files changed in a pull request with their status (added/modified/removed/renamed) and line diff counts.
github/get_repo — Get metadata and stats for a GitHub repository — stars, forks, language, topics, default branch, license, push times.
github/git_add — Stage files for commit. If no files are specified, stages all changes.
github/git_blame — Show who last modified each line of a file. Optionally limit to a line range.
github/git_branch — Create, switch, delete, or list git branches.
github/git_checkout — Restore files from a commit or branch, or discard working tree changes.
github/git_commit — Stage files and create a git commit. If no files are specified, stages all changes.
github/git_conflicts — List files with merge conflicts and show the conflict diffs for each file.
github/git_diff — Show changes between working tree, staging area, or commits.
github/git_fetch — Fetch authenticated remote refs without changing the working tree. Reports remote-tracking refs that were added, updated, or pruned.
github/git_log — Show commit history for a repository.
github/git_pull — Pull commits from a remote repository. Automatically reports any merge conflicts after pull.
github/git_push — Push commits to a remote repository.
github/git_stash — Save, list, apply, pop, or drop stashed changes.
github/git_status — Show the working tree status — current branch, staged/unstaged/untracked files.
github/git_worktree — Add, list, remove, or prune git worktrees — check out multiple branches of one repo into separate directories at once (ideal for reviewing/building several PRs in parallel).
github/heartbeat_claim_issue — Heartbeat issue-discovery (#500) atomic claim + collision guard: records an issue in the heartbeat_seen_issues seen-set via INSERT ... ON CONFLICT DO NOTHING.
github/heartbeat_new_issues — Heartbeat issue-discovery (#500) "touched-before" filter: given the open-issue union from scan_active_issues, returns only issues Heartbeat has NOT handled before — anti-joined against the heartbeat_seen_issues seen-set and excluding issues already assigned to Heartbeat or bearing the claim label. Deterministic, zero-LLM, read-only.
github/init — Initialize a git repository at the specified absolute path.
github/list_branches — List branches in a GitHub repository.
github/list_claims — List active worker file claims, optionally scoped to the repository containing absolutePath.
github/list_pr_reviews — List all reviews on a pull request with their state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED) and authors.
github/list_projects — List Projects V2 boards for an org or user, with each board's node id (projectId, PVT_…), fields, and — for single-select fields like Status — every option id/name. Projects V2 is GraphQL-only (no REST).
github/list_prs — List one page of pull requests with optional filters. Follow the returned next-page instruction to inventory every PR, including drafts.
github/list_repos — List repositories for the authenticated user, a specific user, or an organization.
github/merge_pr — Merge a GitHub pull request. Destructive — refuses without {"confirm":true}.
github/read_file — Read the contents of a file from a GitHub repository.
github/ready_pr — Flip a draft pull request to "ready for review" (draft PRs cannot be merged). Uses the GraphQL markPullRequestReadyForReview mutation.
github/release_files — Release active file claims in one repository by owner label or explicit claim ids.
github/request_pr_reviewers — Request specific users or teams to review a pull request.
github/set_project_field — Set one field on one Projects V2 card via updateProjectV2ItemFieldValue (GraphQL-only) — most often the Status single-select, i.e. moving a card between columns. All ids come from the prior steps: project_id + field_id (+ option_id) from github_list_projects, item_id from github_add_issue_to_project.
github/trigger_workflow_run — Manually trigger a GitHub Actions workflow via workflow_dispatch. The target workflow must declare a workflow_dispatch trigger in its "on:" block.
github/update_file — Update an existing file in a GitHub repository. Automatically fetches the current file SHA required for updates.
github/update_issue — Update an existing GitHub issue — edit title, body, labels, assignees, or state.
github/update_pr — Edit a pull request — update its title, body, base branch, or open/closed state.
kubectl/apply — Apply a Kubernetes manifest file.
kubectl/delete — Delete Kubernetes resources.
kubectl/describe — Describe Kubernetes resources.
ledger/scoreboard — Deterministic outcome-ledger scoreboard (zero LLM): outcomes shipped in the window, WORKING items and how many are staged at a gate, unilateral actions logged in AUDIT.md, and a staleness flag against the 7-day rule. The heartbeat reads this each cycle; the human reads it as the trust-ratchet evidence.
marketplace/diff — Show files only in the marketplace, only local, or differing between your installed copy and the latest marketplace version. Read-only.
marketplace/download — Install a marketplace listing using the same database installer as the Use Cases tab. A package (use case) installs every embedded item in one all-or-nothing transaction.
marketplace/info — Full details for one marketplace listing by kind + slug: template id, version, author, category, tags, downloads, manifest metadata and kind summary, and local install status.
marketplace/list_local — List local artifacts from Postgres, with existing user-owned folders included as a legacy fallback. Filterable by kind.
marketplace/list_published — List everything you have submitted to the marketplace with its review status (pending / live / rejected), download count, and reviewer notes. Requires a Sulla Cloud session.
marketplace/publish — Submit a local artifact to the Sulla Marketplace using the Library publish pipeline. Agents are exported from the database; other kinds come from ~/sulla/.
marketplace/scaffold — Generate a new artifact directory locally with a kind-appropriate skeleton (manifest + handler / soul / compose / etc.). Pure local file generation — does not touch the marketplace.
marketplace/search — Search the whole Sulla Marketplace catalog. Filter by free text, one kind, multiple kinds, and category.
marketplace/unpublish — Take down your own marketplace submission for kind + slug: approved listings are withdrawn (kept in your submissions as rejected), pending ones are deleted. Refuses without {"confirm":true}.
marketplace/update — Update an installed marketplace artifact to the latest version, replacing the local copy in place (restored if the update fails). Errors if it isn't installed from the marketplace (use download instead).
marketplace/validate — Validate a locally-installed artifact against its kind-specific schema. Catches missing required fields, broken entrypoints, slug mismatches, and (for recipes) missing docker-compose.yml.
memory/episodic_recall — Recall Knowledge Base nodes by query or alias. Read-only.
memory/episodic_resolve — Resolve aliases to canonical active Knowledge Base nodes.
memory/episodic_search — Search canonical Knowledge Base nodes without mutating recall or graph strength.
memory/recall_conversations — Search and read the on-disk conversation logs (~/sulla/logs/conv_*.jsonl) — the training-formatted JSONL transcripts of every past user-facing conversation (subconscious agents are never logged here). Unlike search_conversations (which matches DB titles/summaries), this searches the actual message CONTENT and returns transcripts. action:"search" finds past conversations by keyword and returns each hit's id, date, title, and a matching snippet; action:"read" renders one conversation's full transcript by id.
memory/recall_index_lookup — Check the Redis citation index for previously-researched digests BEFORE re-reading files or re-searching directories. Pass a topic and/or a list of file paths.
memory/recall_index_store — Persist freshly-researched citation digests into the Redis citation index so future recall passes can reuse them without re-reading source files. Store one entry per file you read (path + the digest you produced), and optionally a topic with citation strings.
meta/ask_user_question — Pause and ask the user one or more multiple-choice questions, then BLOCK until they answer in the chat (or the timeout elapses — default 5 min). Renders an interactive card with selectable options; the user may also type a free-form answer.
meta/dry_run_workflow — Walk a workflow statically — parse YAML, traverse from triggers, report execution order and any orphans or runtime-ambiguous branches. Does NOT execute any node (no side effects).
meta/exec — Run any shell command inside a fully isolated sandboxed Linux VM with root access. This is ALSO how you invoke every `sulla <category>/<tool>` CLI command surfaced by browse_tools — pass the full `sulla ...` command string as the `command` arg (e.g. command: "sulla github/create_issue '{\"title\":\"bug\"}'").
meta/exechost — LAST RESORT host shell — runs a command on the HOST macOS machine, NOT the Sulla VM. Default to regular exec (VM sandbox) for everyday work; home files are already mounted into the VM.
meta/execute_workflow — Execute a pre-registered workflow by its EXACT slug. Only call this when the slug appears verbatim in the "Available workflows" section of your system prompt — never guess a slug from the user request (e.g. do NOT invent slugs like "browser-tab-open" or "ask-date-time" unless they are explicitly listed).
meta/pause_workflow — Pause a running workflow without releasing it. Cooperative — PlaybookController checks a Redis flag at each frontier tick and halts frontier advance.
meta/restart_from_checkpoint — Restart a workflow execution from a specific node checkpoint. Use workflowId alone to list recent executions, executionId alone to list checkpoints, or executionId + nodeId to restart from that node.
meta/resume_workflow — Resume a workflow paused with pause_workflow by clearing its pause flag. The orchestrator resumes frontier advance on its next tick.
meta/spawn_agent — The one way to delegate. Launch one or more child agents, each with a return contract. visibility "hidden" (default) runs the child in the background; visibility "tab" opens it as a live chat tab the human can join (use for leads that run their own team or keep a visible Playbook).
meta/stop_workflow — Request a running workflow to stop. Cooperative — writes a Redis flag the PlaybookController checks at each frontier tick, so the running orchestrator honors it on its next step.
meta/validate_sulla_workflow — Validate a Sulla workflow YAML file for structural correctness before it goes live. Checks top-level schema, node types, subtype/category mapping, required config fields, edge format, trigger presence, and reachability.
mobile/list_devices — List every desktop and mobile device registered to the account, annotated with online/offline status. A device is "online" when it has hit the worker within the last 2 minutes (heartbeat or any authenticated call).
models/list — List models available for one provider using Sulla provider discovery, with static catalog fallback when live discovery is unavailable.
models/providers — List AI model providers, whether each is connected/on or disconnected/off, whether any required CLI is installed in the Sulla VM, and whether Sulla can use it.
models/usage — Read locally tracked usage, API-equivalent cost estimates, model breakdowns, trends, and the latest subscription limit windows emitted by provider CLIs.
notify/history — Read the notification history. Every notify_user call writes a row with title, message, targets, delivered flag, and any error.
notify/user — Send a notification to the user. Default target is "desktop" (native macOS / Notification Center).
observation/add_identity_observation — Store a focused identity observation into the domain-keyed identity_observations table (human / business / world / agent / environment / projects / skills — mirrors ~/sulla/identity/). Levels are CERTAINTY: 3 = stated fact (subject directly told us), 2 = derived fact (established from conversation evidence), 1 = conclusion (reasoned from L3/L2 facts — personality, style, habits).
observation/add_observational_memory — Use this tool to store the observations you make into long-term memory.
observation/list_identity_observations — List active identity observations for one domain, most certain first (L3 stated → L2 derived → L1 concluded) then most recent. Optionally filter by level and/or category.
observation/list_observations — List active observational memories sorted by priority (critical/high first) then recency. Optionally filter by priority level.
observation/remove_identity_observation — Archive (soft-delete) an identity observation by its ID. The record is never hard-deleted — it is marked archived=true so the history is always recoverable.
observation/remove_observational_memory — Archive (soft-delete) a specific observational memory by its ID. The record is never hard-deleted — it is marked archived=true so the history is always recoverable.
observation/search_conversation_keywords — Read-only search for the Conversation Reader over the conversation_keywords index. Pass term (or query) for exact canonical-term match, falling back to pg_trgm fuzzy match, falling back to ILIKE over conversation_history title/summary/last_summary; or pass thread_id to list every indexed keyword for that thread.
observation/search_conversation_logs — Read-only search over ~/sulla/logs/ for the Conversation Reader. Pass thread_id to resolve that conversation's specific log file(s) (channel-scoped .log plus the conv_<id>.jsonl event stream); omit it to scan all thread-scoped log files within a recency window (since / days).
observation/search_identity_observations — Search active identity observations within one domain (human / business / world / agent / environment / projects / skills) by meaning with the ranked recall engine (keyword + embedding search + learned ranker), so paraphrases match. Rows include a relevance score, best first. include_archived falls back to any-word keyword matching.
observation/search_observations — Search active observational memories by meaning with the ranked recall engine (keyword + embedding search + learned ranker), so paraphrases match. Returns compact rows (id, priority, timestamp, relevance score, content), best first. include_archived falls back to any-word keyword matching.
observation/update_identity_section — Write the consolidated identity profile for a domain into its system-prompt section (e.g. the "user" section injected into every system prompt). Overwrites the section content and marks it customized so the boot seeder never clobbers it.
observation/upsert_conversation_keywords — Observer-only database writer for salient terms from the completed conversation turn. Canonicalizes and upserts terms by (term, thread_id), bumping hit_count and last_seen on repeats.
pg/count — Execute a PostgreSQL count query and return the count.
pg/execute — Execute a PostgreSQL statement and return execution results.
pg/query — Execute a PostgreSQL query and return results.
pg/queryall — Execute a PostgreSQL query and return all result rows.
pg/queryone — Execute a PostgreSQL query and return the first result row.
pg/transaction — Execute multiple PostgreSQL statements in a transaction.
redis/decr — Decrement the integer value of a Redis key by one.
redis/del — Delete one or more Redis keys.
redis/expire — Set a timeout on a Redis key.
redis/get — Get the value of a Redis key.
redis/hget — Get the value of a field in a Redis hash.
redis/hgetall — Get all fields and values from a Redis hash.
redis/hset — Set the value of a field in a Redis hash.
redis/incr — Increment the integer value of a Redis key by one.
redis/lpop — Remove and return the first element of a Redis list.
redis/rpush — Append one or more values to a Redis list.
redis/set — Set the value of a Redis key.
redis/ttl — Get the time to live (TTL) of a Redis key.
reflex/correct — Tell the Reflex engine one of its decisions was wrong. Records a counter-example for that message and action, and — when you pass the correct tool/params (or tool "none") — teaches the right answer too.
reflex/export — Export the active Reflex training set as JSON ({version, examples:[{utterance, tool, params, positive}]}) so it can be reviewed or shipped as a production seed. Optionally writes it to a file path; re-import with reflex_teach examples[] and source "seed".
reflex/forget — Forget (soft-archive) a Reflex training example by id. It stops influencing decisions immediately but stays recoverable.
reflex/list_examples — List Reflex training examples, newest first. Filter by text in the utterance or by tool name.
reflex/predict — Dry-run the Reflex engine on a message: returns the tool/params it would pick, its confidence, the current threshold, whether it would act, and the nearest training examples. Never executes anything.
reflex/stats — Reflex engine status: enabled flag, confidence threshold, allowed categories, example counts, decision counts by outcome, corrections, and the most recent decisions.
reflex/teach — Teach the Reflex engine what to do for a user message: map an utterance to ONE Sulla tool call (tool + params) that fully satisfies it, or to tool "none" for messages that should never trigger an action. Set positive:false to teach "do NOT do this for this message".
rules/add_rule — Add or update a user-created rule the Security Conscience should enforce (e.g. "always confirm before touching prod", "never deploy on Fridays"). Provide an id to update a specific rule in place; otherwise a substantially similar existing rule is updated instead of creating a duplicate.
rules/archive_rule — Archive (soft-delete) a user-created rule by its id. The record is never hard-deleted — it is marked archived=true so the history is always recoverable.
rules/list_rules — List active user-created rules from the rules table, most severe first then recency. These are the rules the human wants honored (security, operational, personal).
rules/search_rules — Search user-created rules by keyword or phrase across title + content. The query is split into words and any rule containing ANY meaningful word matches (stopwords ignored), ranked by phrase hit then word-match count.
secretary/start — Start Secretary Mode — opens (or focuses) a Secretary tab and auto-begins the listening session. Use when the user asks to "start taking notes", "enter secretary mode", "listen to my meeting", etc.
secretary/status — Check whether Secretary Mode is currently listening. Returns JSON { listening: boolean, tabId: string | null }.
secretary/stop — Stop Secretary Mode — ends the active listening session. Use when the user asks to "stop taking notes", "end secretary mode", "stop listening".
settings/get — Read a Sulla Desktop setting through SullaSettingsModel (Redis cache → Postgres → file fallback). Use this instead of redis_hget on sulla_settings — raw Redis reads of that hash are blocked.
settings/set — Write a Sulla Desktop setting through SullaSettingsModel so Postgres and the Redis cache stay in sync. Use this instead of redis_hset on sulla_settings — raw Redis writes of that hash are blocked.
skills/skill_disable — Disable, re-enable, or soft-delete a skill in the database. Disabled and deleted skills stop showing up for agents; nothing is ever hard-deleted, and a deleted slug is never re-imported from folders or re-seeded by app updates. skill_save restores a deleted skill.
skills/skill_get — Load one skill from the database: its full SKILL.md (frontmatter + body) and the list of its extra files. Set materialize:true to also write the skill folder to ~/sulla/cache/skills/<slug>/ and get that path back, for skills whose scripts or html must run from disk.
skills/skill_list — List the skills in the database (slug, title, source, enabled, triggers). Pass query to search titles, descriptions, tags, triggers and bodies.
skills/skill_save — Create or update a skill as a draft in Files from SKILL.md text: a YAML frontmatter block (slug, title, tags, triggers, ...) followed by the markdown body. Optionally pass files (relative path -> text) to store extra files such as templates/ or scripts/.
slack/connection_health — Check Slack integration health and auto-reinitialize if disconnected/unhealthy.
slack/search_users — Search Slack users by username, real name, display name, or email.
slack/send_message — Send a new message to a Slack channel.
slack/thread — Get replies in a Slack thread.
slack/unreact — Remove a reaction emoji from a Slack message.
slack/update — Update an existing Slack message.
slack/user — Get information about a Slack user.
ui/open_tab — Open or focus a built-in Sulla Desktop view (Use Cases, vault, integrations, routines, history, secretary, chat, document, browser, files, agents, decide, preferences, docker). Use this when the user asks to "open" or "show me" a section of the app.
vault/autofill — Autofill a login form on the active browser tab, or an explicitly requested background tab, with saved vault credentials. Success is returned only after the target tab proves the expected fields are non-empty.
vault/delete_credential — Delete a single credential property from the vault. Destructive — refuses without {"confirm":true}.
vault/is_enabled — Check whether a specific integration is enabled (connected). Returns the enabled status along with connection timestamps.
vault/list — List all saved website credentials in the vault. Shows website URLs and usernames for accounts where AI access is permitted.
vault/list_accounts — List all accounts configured for an integration. Shows account labels, connection status, and which account is currently active.
vault/list_api_keys — List vault API key and Login items opened to this agent for outbound API requests. Returns id, name, type, allowed hosts and rule metadata only; never secret values or sources.
vault/read_secrets — Retrieve the credentials and connection status for a specific integration. Shows all accounts if multiple exist, with the active account highlighted.
vault/request — Call an HTTPS API using an owner-configured vault item without seeing its secret. Resolve an id or exact name from vault/list_api_keys.
vault/set_active_account — Set which account is active for an integration. After setting the active account, all subsequent tool calls for that integration will automatically use its credentials.
vault/set_credential — Store or update a credential for an integration account. The value is encrypted in the vault and never appears in conversation after this call.
workflow/catch_up_schedules — Detect scheduled workflow fires that were missed (app off or scheduler dormant when the cron time passed) and dispatch them through the real executor. Compares each armed schedule's previous expected fire time against workflow_executions.
workflow/display_workflow — Surface a Postgres-backed routine as a workflow artifact in the chat sidebar.
workflow/find_repeated_tasks — Promotion detector for routine stewardship: returns operations that have recurred across >= threshold DISTINCT sessions (deterministic shape-signature over the per-action tool log; zero-LLM) as candidates to codify into a routine (needs judgment) or a zero-token function (deterministic). Call this when deciding what recurring work to push down the cost ladder.
workflow/import_workflow — Import an inline YAML workflow definition into Sulla Files as a draft. Only a published version can be executed.
workflow/refresh_schedules — Force WorkflowSchedulerService to re-scan production workflows and re-arm all schedule triggers, then report exactly what is armed (cron, timezone, next fire time). Use after any direct DB change to workflows, or to verify a routine is actually armed — no restart, no log-grepping.
workflow/routine_report — Drill-down report for a routine flagged by routines_digest: last-run status, timing, error, and the step-by-step tool-call trace (from workflow_checkpoints) explaining why it did what it did. The diagnosis payload — pull it only when the digest flags a failure/zombie, never into standing context.
workflow/routines_digest — Deterministic delta + exceptions-only digest of routine health (zero-LLM to produce, tiny to consume). All-green with nothing new = one line; otherwise lists only routines whose last run failed, that have a zombie run, or that were newly created in the last 24h.
workflow/set_workflow_status — Enable/disable a workflow or change its status (draft | production | archive) by id or exact name, then re-arm the scheduler so the change takes effect immediately without an app restart. Reports the workflow's armed cron state after the change.
