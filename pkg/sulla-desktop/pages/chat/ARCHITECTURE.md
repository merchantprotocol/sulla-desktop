# Chat Architecture

**Status:** Phase 0–3 scaffolded 2026-04-23. Lives behind feature flag `useNewChatUI`; old `BrowserTabChat.vue` stays wired until phase 5 parity.

## North star

One controller per thread, many dumb components. `ChatController` owns all mutable state and is the only thing that mutates it. Every view component reads from it and dispatches intents back — never reads from siblings, never keeps its own copy of shared state. The DOM is a derived function of controller state.

Multiple threads live concurrently — one `ChatController` per open tab/history entry — and a `ThreadRegistry` tracks them so switching history items is free (the state already exists, just pick a different active controller).

## Directory

```
pages/chat/
├── ARCHITECTURE.md              # This file.
├── ChatPage.vue                 # Top-level route. Wires controller → views. No logic.
│
├── types/
│   └── chat.ts                  # Branded IDs (ThreadId, MessageId, ArtifactId, …)
│
├── models/                      # Plain data. No Vue. No DOM.
│   ├── Message.ts               # Discriminated union by `kind`
│   ├── Thread.ts                # Thread shape + ThreadState for serialization
│   ├── Artifact.ts              # workflow | html | code | markdown artifact
│   ├── Attachment.ts
│   ├── QueuedMessage.ts
│   ├── VoiceState.ts
│   ├── RunState.ts              # State-machine phases
│   ├── Command.ts               # Slash commands + mention targets
│   └── index.ts
│
├── controller/
│   ├── ChatController.ts        # SINGLE SOURCE OF TRUTH (per thread)
│   ├── ThreadRegistry.ts        # Tracks all open controllers (multi-thread support)
│   ├── runStateMachine.ts       # Pure fn: (state, event) → nextState
│   ├── events.ts                # Typed event union for subscribers
│   └── useChatController.ts     # provide/inject composable
│
├── services/
│   ├── VoiceSession.ts          # mic + whisper + TTS (wraps useVoiceSession)
│   ├── AttachmentService.ts     # drag-drop + staging + kind/size
│   ├── ArtifactRegistry.ts      # per-thread artifact list
│   ├── Transport.ts             # the only backend I/O surface
│   └── ModelRegistry.ts         # available models
│
├── composables/
│   ├── useKeyboardShortcuts.ts  # ⌘K / ⌘F / ⌘/ / ? / Esc
│   ├── useDragDrop.ts
│   ├── useScrollAnchor.ts
│   ├── useCommandPopover.ts     # slash/mention detection in textarea
│   └── useResizeSync.ts         # composer height → scroller padding
│
├── components/
│   ├── transcript/              # Transcript, MessageRouter, turns, hover actions
│   ├── thinking/                # live / settled / expanded
│   ├── tool/                    # ToolCall, ToolApproval
│   ├── patch/                   # PatchBlock + sub-parts
│   ├── channel/                 # ChannelMessage (from other agents)
│   ├── subagent/                # SubAgentBubble
│   ├── citation/                # CitationRow + CitationCard
│   ├── memory/                  # MemoryNote
│   ├── proactive/               # ProactiveCard
│   ├── composer/                # Composer + input/mic/attach/voice/queue/run
│   ├── popover/                 # Slash + mention autocomplete
│   ├── artifact/                # Sidebar + tabs + header + panes
│   ├── history/                 # HistoryRail + items
│   ├── chrome/                  # Canvas, SessionMark, badges, modals, toasts
│   └── empty/                   # EmptyState + suggest chips
│
└── styles/
    ├── tokens.css               # steel-blue palette, ink ramp
    ├── reading.css              # 19.5px serif, 1.8 lh, 65ch column
    └── canvas.css               # breathing glows + starfield
```

## The controller

```ts
class ChatController {
  // Reactive state — the ONLY source of truth
  readonly thread:     Ref<Thread>
  readonly runState:   Ref<RunState>           // discriminated union, state machine
  readonly queue:      Ref<QueuedMessage[]>
  readonly staged:     Ref<Attachment[]>
  readonly voice:      Ref<VoiceState>
  readonly artifacts:  Ref<{ list: Artifact[]; activeId: ArtifactId | null }>
  readonly popover:    Ref<PopoverState>
  readonly modals:     Ref<ModalState>
  readonly sidebar:    Ref<{ historyOpen: boolean }>
  readonly connection: Ref<'online' | 'degraded' | 'offline'>
  readonly model:      Ref<ModelDescriptor>

  // Commands — the ONLY way to mutate state
  send(text, attachments?)
  queue(text)
  stop() / continueRun()
  editMessage(id, text) / regenerate(fromId) / pin(id) / fork(fromId)
  applyPatch(id) / rejectPatch(id)
  approveTool(id) / denyTool(id)
  startVoice() / stopVoice(commit)
  stageAttachment(file) / unstageAttachment(id)
  openArtifact(kind, opts) / switchArtifact(id) / closeArtifact(id)
  openModal(which) / switchModel(model) / toggleHistory()
  showPopover(mode, query) / hidePopover() / insertPopoverSelection()
  saveMemory(content, priority)

  // Serialization — for multi-thread + history rehydration
  serialize(): ThreadState
  static hydrate(state: ThreadState): ChatController

  // Events
  on<E extends ChatEvent>(kind, handler): Unsubscribe
}
```

## Multi-thread support

- `ThreadRegistry` holds all open `ChatController` instances keyed by `ThreadId`.
- `activeThreadId` selects which one the UI shows.
- When user clicks a history item, `ThreadRegistry.activate(threadId)` loads from storage (or finds already-open) and flips the active key.
- Each tab in the desktop app runs its own registry-backed controller — no cross-talk.
- `ChatController.serialize()` produces `ThreadState` for persistence; `ChatController.hydrate(state)` restores one.

## Run state machine

```
idle ─ send()/queue-drain ─▶ thinking ─ spawn tool ─▶ tool ─ done ─▶ streaming
 ▲                             │                                       │
 │                         stop/error                               stream end
 │                             ▼                                       │
 └─────────────────────────── paused ◀── hit-limit ─────────────────── │
                                                                       ▼
                                                                      idle
```

Codified as a pure function `nextRunState(current, event) → next` in `runStateMachine.ts`. Every `runState` mutation goes through it.

## Message router pattern

`Transcript.vue` iterates `thread.messages` and hands each to `MessageRouter.vue`, which switches on `msg.kind` and picks a component. Adding a new message kind = one file + one line in the router map. Zero other changes.

## Patterns & rationale

| Pattern | Where | Why |
|---|---|---|
| **Container / presentational** | `ChatPage`, `Transcript`, `Composer`, `ArtifactSidebar` are containers; everything else is presentational | Presentational components are reusable, testable, and trivially swappable. |
| **Discriminated unions** | `Message.kind`, `RunState.phase`, `Artifact.kind` | Exhaustiveness at compile time. Adding a kind forces handling everywhere. |
| **State machine for runs** | `runStateMachine.ts` | Makes invalid transitions unrepresentable. No `graphRunning` lies. |
| **Command–Query separation** | Controller methods are either commands (void) or queries (read-only refs) | A method never both returns data and mutates state. |
| **Event bus** | `ChatController.on('messageAppended', fn)` | Telemetry, tests, and cross-component reactions without coupling. |
| **provide/inject** | `useChatController()` | No globals. Multiple threads side-by-side. |
| **Composables for cross-cutting UI** | keyboard, drag-drop, scroll, resize, popover | One file per concern. No scatter. |
| **Pure models** | `models/` | Serializable, testable, IPC-safe. |

## Phased migration

| Phase | Scope | Ship-gate |
|---|---|---|
| **0** | Foundation: types, models, controller, state machine, composable, registry | All existing `ChatInterface` behavior reproduced in controller unit tests. |
| **1** | `ChatPage.vue` + Transcript + MessageRouter + user/sulla/thinking/tool/patch. Canvas + reading styles. | Feature parity for basic text turns. |
| **2** | Composer decomposition + voice + attachments + queue + run controls + keyboard. | Full composer parity. |
| **3** | Artifact sidebar (workflow + html + code + markdown panes). Patch → Open File wires in. | Artifact lives when Sulla runs a routine. |
| **4** | Channel + subagent + citations + memory + proactive + approval + model switcher + search + shortcuts + history rail. | `chat-whisper-full.html` parity. |
| **5** | Swap `BrowserTabChat.vue` → `ChatPage.vue`. Delete old file. | No regressions. |

Feature flag: `useNewChatUI` (setting). Old path untouched until phase 5.

## Testing

- **Unit (controller):** every command + every state transition. 100% branch coverage.
- **Component:** each message kind rendered against a fixture.
- **Integration:** full-session flows (send → think → tools → reply → queue → patch → apply → open artifact).
- **Visual:** Playwright screenshots vs the demo playground in `_design-ideas/chat-whisper-full.html`.

## Open questions

1. Does an artifact belong to a thread or a tab? (Currently: thread.)
2. HTML artifact sandboxing — iframe + CSP, reusing `HtmlMessageRenderer.vue`.
3. Workflow artifact live updates — need a dedicated WebSocket channel for routine execution events.
4. History rail virtualization kicks in at ~50 threads.

## Browser chat preview (Sulla VM only)

The preview uses the renderer's Webpack dev server with its own web target and
entry point (like the Files and theme previews). It mounts the real ChatPage,
Transcript, and Composer with synthetic data. Preview-only aliases replace
Electron IPC, settings, the legacy persona runtime, and live workflow events.
No Electron, Lima, Playwright, browser downloads, or app postinstall are needed.

From the repository root **inside the VM**, using Node 22:

```sh
npm ci --prefix scripts/chat-preview --ignore-scripts --cache /tmp/sulla-chat-preview-npm
npm --prefix scripts/chat-preview start
```

Open `http://127.0.0.1:8888/chat-preview.html?theme=default-light&fixture=agent`.
Use the toolbar or the `theme`, `fixture` (`long` or `agent`), and `dock`
(`bottom` or `side`) query parameters. Reloading resets the selected fixture.
Source links use reserved placeholder URLs; sending and other live services are
not available. Stop the foreground server with Ctrl-C.

To open the preview in the Sulla browser from a bounded agent container,
run it as a VM Docker service after the same install. Bind-mount the repo
read-only; Sulla forwards the published loopback port to its browser:

```sh
docker run --rm -d --name sulla-chat-preview -p 127.0.0.1:18889:8888 \
  --read-only --user "$(id -u):$(id -g)" -e CHAT_PREVIEW_HOST=0.0.0.0 \
  -v "$PWD:/preview:ro" --entrypoint node \
  ghcr.io/merchantprotocol/sulla-node-runtime:latest /preview/scripts/chat-preview/serve.cjs
```

Open the same URL on port `18889`. Stop it with `docker stop sulla-chat-preview`.
After a VM restart, rerun the launch command (and the dependency install if
`scripts/chat-preview/node_modules` is missing). Use distinct container names
and published ports to compare two worktrees. From an agent without the Docker
binary, use the Sulla `docker/run` and `docker/stop` tools with the same options.
