# Sulla Desktop — Architecture

## Overview

Sulla Desktop is an Electron application with three distinct execution environments:

| Layer | Where it runs | What lives there |
|-------|--------------|-----------------|
| Electron Main Process | Host macOS/Linux | Service orchestration, IPC handlers, Lima control, vault, MCP server |
| Lima VM | Linux guest (QEMU) | Docker containers: Postgres, Redis, Python/Node/Shell runtimes |
| Vue Renderer | Electron window | Chat UI, AgentRoutines, workflow canvas |

Agent turns run through Sulla's own graph + model-provider layer, not a single hardcoded model. Some providers are API-backed (Anthropic, OpenAI); command-line providers (Claude Code, OpenAI Codex) spawn CLI processes inside Lima and stream results back through the same graph. Tool calls route through the Sulla Tools API / in-process MCP server, and channel messages return over WebSocket. Around every actionable turn, a **subconscious layer** recalls memory before the reply and writes observations after — see [`environment/subconscious.md`](subconscious.md).

---

## Electron Main Process

Application service registration: `pkg/rancher-desktop/sulla.ts`

`instantiateSullaStart()` bootstraps application storage and registers services
with ServiceLifecycleManager, which starts them by declared dependency.
The application exposes the chat/tools HTTP server on port 3000, the internal
Basic-auth extension command API on 6107, and Terminal WebSocket on 6108.
Do not assume the chat server is ready before its database dependency.

```
instantiateSullaStart() → bootstrapSullaHome()
   → ServiceLifecycleManager.startAll()
   Connections: postgres, redis (persistOnRestart)
   Database layer: database-manager (postgres)
   Application services include scheduler, heartbeat, workflow-scheduler,
   workflow-container-events, chat-server, local-tool-tunnel, accounts, vault,
   sulla-files-runtime, sulla-files-maintenance, projects-auto-archive,
   projects-domain-events, knowledge-projection-outbox, model-provider,
   integrations, oauth, file-search and host-access-sync.
   Independent bridges include backend-ws, relay-tool-tunnel,
   model-provider-ipc and mcp-server-host.
```

`postgres` and `redis` are marked `persistOnRestart` — a backend restart re-uses the live connections instead of tearing them down.

---

## Lima VM

### Disk vs memory in the VM

The VM's / is tmpfs, a RAM disk. /tmp and the guest user's home directory
are RAM-backed; work there eats memory and vanishes on restart. Never put
agent work there. Persistent disk is /mnt/data, with bind mounts at
/mnt/worktrees and /var/lib/docker. Agent container workspaces live under
/mnt/data/sulla/runtime/agents.

Use /mnt/worktrees/<repo>-<branch> for code and
/mnt/worktrees/_scratch/<your job id>/ for scratch. Inside an agent
container, use your working directory instead. Delete scratch when done.
Move only finished work into /mnt/sulla-files.

Lima runs Alpine Linux. `backend/lima.ts:getMounts()` mounts only app-owned
transport/cache roots: `/tmp/rancher-desktop`, `paths.cache`, `paths.logs`, and
`paths.resources` (read-only). The host home is not mounted. Selected host
content is reached through Files, not raw host paths.

Agent files are exposed at `/mnt/sulla-files`. Git worktrees use
`/mnt/worktrees`, bind-mounted from persistent `/mnt/data/worktrees` by
`assets/lima-config.yaml`. The VM's guest-owned HOME is kept by CommandRunner.

**Base Docker containers inside Lima:**

| Container | Published port | Purpose |
|-----------|----------------|---------|
| sulla_postgres | 30116 | PostgreSQL |
| sulla_redis | 30117 | Redis (no persistence) |
| sulla_python_runtime | 30118 | Python functions |
| sulla_shell_runtime | 30119 | Shell functions |
| sulla_node_runtime | 30120 | Node.js functions |

Function runtimes mount VM-owned function catalog and invocation directories,
not host `~/sulla/functions`. See [docker.md](docker.md) for image sources.

The `sulla` CLI is installed at `/usr/local/bin/sulla` in Lima. Use `meta/exec`
for VM commands. `meta/exechost` is a separate host-only escape hatch, not a
substitute for Files or normal VM development.

### Background task completions (Claude Code)

`claude -p` runs in Lima via `ClaudeCodeService`, which keeps one warm CLI process per conversation between turns (the warm pool). When the model starts background work (`Bash run_in_background`, `Monitor`) and it finishes after the turn, the CLI emits `system/task_notification` and runs its own follow-up turn. The parked process keeps being read, and `claudeBackgroundTasks.ts` routes the completion into the owning graph thread:

- **Idle thread** — woken immediately with a `user_message` (`metadata.source: background_task_completion`, `inputSource: system`), the same primitive `spawn_agent` uses; the next turn adopts the same process.
- **Busy thread** — held and retried every 15s until the thread goes idle (a `user_message` on a running thread would abort it); a turn that starts first gets the notice prepended to its prompt instead.
- **Sub-agents / observers** — never woken (they have already returned); the notice waits for that conversation's next turn.
- The 5-minute idle reap is deferred while background tasks are live, up to 4 hours.
- Warm pool disabled (`claudeCodeWarmPool=false` and `claudeCodeSpeculativeBoot=false`): the turn settles at `result` and the CLI stops its background tasks shortly after; the graph is woken with the `[stopped]` notice.

---

## Browser tabs: security model

Browser tabs are `WebContentsView`s in the `persist:sulla-browser` session. They run arbitrary websites, so everything in this session counts as **untrusted web content**:

- **Injected scripts** — `browserTabPreload.ts` injects `window.sullaBridge` (DOM helpers for `GuestBridge.ts`) and `window.__sulla` (the runtime used by `browser/exec`) into every frame at document-start. They do nothing until an agent tool calls them; there is no passive event streaming.
- **IPC** — `main/ipcGuestGuard.ts` wraps `ipcMain` handler/listener. Senders from the browser session are rejected unless the channel is on `GUEST_ALLOWED_CHANNELS` (`sulla-settings-get` for `theme` only, and `browser-tab-view:bridge-event`). Any new channel the tab preload uses must be added there.
- **Vault** — bridge events are bound to `event.senderFrame.origin`; a page only ever sees and autofills accounts saved for its own origin.
- **Site permissions** — `main/browserTabs/browserPermissions.ts`: camera/mic, location, clipboard read, screen share etc. prompt once per site (saved in `userData/browser-site-permissions.json`); pages the user can't see (parked/agent tabs) are denied without a prompt. Fullscreen, pointer lock, DRM and notifications are allowed.
- **`chrome.*`** — web pages get no `chrome.*` APIs (same as Chrome). `main/chromeApi/ChromeApiService.ts` is Sulla's *internal* implementation of the Chrome extension API shape, used by agent tools and Sulla's own UI over `chrome-api:*` IPC — which web content cannot reach. Sulla does not load Chrome extensions today; supporting them would mean `session.extensions.loadExtension` plus mapping these APIs onto the extension runtime.

## Vue Renderer

Managed Files operations go through IPC to the main process and the Files service. This is not a blanket renderer filesystem sandbox: several trusted windows enable Node integration; Capture Studio writes recording tracks directly. Chat messages travel over WebSocket to BackendGraphWebSocketService.

---

## App Resources Path

In the **packaged app** (DMG/installer):
```
Sulla Desktop.app/Contents/Resources/resources/
```

In **development**:
```
<repository>/resources/
```

Accessed in code via `paths.resources`. This directory is **mounted read-only into Lima** — so anything in `resources/sulla-docs/` is readable inside Lima at the same absolute path.

---

## WebSocket Channels

The BackendGraphWebSocketService routes messages by channel name:

| Channel | Consumer |
|---------|---------|
| `sulla-desktop` | Frontend chat agent |
| `heartbeat` | Autonomous heartbeat agent |
| `mobile-relay` | Paired mobile device |
| `calendar_event` | Calendar trigger |

Messages keyed by `${channelId}|${threadId}` for concurrent execution.

## Goal ownership in system-prompt assembly

`agent/prompts/sections/goalOwnership.ts` defines the shared `goal_ownership`
section. The section registry enables it in full, minimal, and local modes at
priority 25, after Soul. Base-only (`none`) calls do not receive it. The policy
keeps responsibility scoped to the assigned outcome, requires verified completion,
preserves unfinished goals across new messages, and respects stops, approvals,
and existing workflow ownership. It does not implement message queueing or retries.

The section is separate from Soul so an existing customized Soul row or agent
`soul.md` does not hide the new instruction. `systemPromptSectionDefaults.ts`
provides its enabled-by-default database seed and Reset to default content.
Normal builder precedence still applies to `goal_ownership` itself: explicit
agent override, then database content, then the compiled fallback. Explicit
section exclusions are honored.

`BaseNode` loads database rows and disabled-section exclusions before calling
`SystemPromptBuilder`. The separate `buildFullSystemPrompt` helper also uses the
section registry, so the compiled policy reaches generated Claude Code/Codex
memory files. That helper currently does not load database sections; changing a
DB row alone therefore does not update every provider's generated memory file.
Ship source changes through merge and rebuild, then verify a newly assembled
prompt/new CLI session. An already-running session is not proof of activation.
