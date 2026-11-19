# Design spike: process-per-tab for Sulla Desktop

**Status:** Proposal only; no product code changed.
**Evidence base:** origin/main at 94f7c97e70389cceaa224fc4da65587ae412ad17 (2026-11-18).

## Executive summary

A Sulla agent BrowserWindow already owns an Electron renderer process. The resource question is inside that window: AgentRouter renders a BrowserTab.vue for every internal tab in the same renderer and intentionally keeps hidden tabs mounted. This does not mean every possible screen body is simultaneously mounted: each tab's current mode is selected through mutually exclusive v-if branches, but the current body, shell, watchers and component-owned state of every hidden tab remain alive. Several synchronous mode modules are imported up front; selected heavy components are already async-loaded.

Recommend a hybrid, staged approach. First measure process and tab costs; reduce hidden-tab work and add explicit same-renderer hibernation; then move only measured heavy surfaces into their own WebContentsView renderer. This can eventually support killing one selected tab process without sacrificing a separate-process baseline for every light tab. Do not claim memory savings until measurements show them.

This spike did not inspect iMac logs or collect live RSS/CPU data. Code proves the lifecycle architecture, not per-feature memory cost on a particular machine. Establish a repeatable baseline before setting idle thresholds or promising savings.

## 1. Current reality

### Window and process boundary

createWindow constructs a BrowserWindow in pkg/sulla-desktop/window/index.ts:81-93; agent windows are created with their renderer preferences at :200-224. Electron gives each BrowserWindow webContents a renderer process by default, so separate Sulla windows are already distinct renderer/fault domains. Internal Vue tabs are not.

The agent-window renderer boots one Vue app and one AgentRouter (pkg/sulla-desktop/entry/agent.ts:39-64). It creates and starts one AgentStateClient for that renderer (:53-58), stopped on beforeunload. Thus more internal tabs do not each create that client; more windows do.

### What loads and mounts

BrowserTab.vue statically imports many mode components, including Files, Chat, History, Labs, Integrations, Calendar and Routines Home (pkg/sulla-desktop/pages/BrowserTab.vue:396-425). Routines canvas, File Editor, Terminal, Support Session, Preferences and Docker use defineAsyncComponent (:427-435), deferring module loading until first render.

AgentRouter renders every browserTabs entry as BrowserTab (pkg/sulla-desktop/pages/AgentRouter.vue:70-77). Its comment says browser tabs remain outside keep-alive and are hidden with visibility:hidden rather than removed (:62-68). Non-browser routes are retained under keep-alive (:47-60).

Inside BrowserTab, tabMode comes from the tab descriptor (:472-478), and its content uses mutually exclusive v-if / v-else-if mode branches (:196-393). Chat, Files, Docker, and Workflows mount in their respective branches. Therefore:
- Hidden tabs keep their BrowserTab instance, header, reactive effects/listeners and whichever mode body they currently represent. isVisible gates some work but does not unmount the tree.
- Inactive modes within one tab are generally destroyed when the v-if branch changes; they are not all mounted at once.
- Synchronous imports remain in the renderer dependency/module graph despite inactive v-if branches. Async modules load on first use and may stay in that renderer's module cache.
- App-level stores/services are per renderer/window, not duplicated per BrowserTab unless a body creates its own instance.

External websites differ: BrowserTab creates a native browser-tab-view on demand (pkg/sulla-desktop/pages/BrowserTab.vue:930-956). BrowserTabViewManager says each WebContentsView has its own Chromium renderer and all such tabs share the persist:sulla-browser session (pkg/sulla-desktop/window/browserTabViewManager.ts:76-83). The manager tracks views/owners/focus (:88-103). External page JS heaps already have process boundaries; this spike concerns first-party internal surfaces.

### What stays alive when hidden

The BrowserTab shell isn't destroyed as routes change. It receives isVisible, while a watcher sends focus/visibility IPC to main (pkg/sulla-desktop/pages/BrowserTab.vue:1125-1159). Existing browser WebContentsViews are parked, not discarded. Their webPreferences explicitly disable background throttling (browserTabViewManager.ts:357-384) because the compositor must continue painting reliably. This is a reliability tradeoff, not evidence that idle CPU is zero.

Mode component lifetimes differ: the current body in every hidden tab remains mounted, so its timers, subscriptions, observers, workers, cached DOM/data or editors may remain alive. Changing mode typically destroys that body's v-if branch. Window-level handlers and polling remain alive too; AgentRouter refreshes footer stats every 30 seconds (pkg/sulla-desktop/pages/AgentRouter.vue:804-810). Chat turns execute in main/backend agent runtime; the renderer displays/subscribes to them rather than owning execution. Existing #2692 addressed long-session chat renderer growth, evidence that targeted renderer lifecycle optimization can matter without process-per-tab.

### Where memory goes

Measure these separately rather than attributing every MB to tabs:
1. Main process: Electron/app services, databases, agent runtime/graphs, queues and caches. Killing a UI renderer won't reclaim this.
2. Agent-window renderer: Vue shell, loaded module graph, one BrowserTab per internal tab, each hidden tab's live mode body, store(s), and one AgentStateClient per renderer.
3. External-page renderers: one process per created WebContentsView; parked views persist.
4. GPU/compositor/shared resources: not necessarily visible as a simple renderer RSS sum.
5. Backend/remote services: chat execution, workflows, containers and services may use resources outside Chromium.

useBrowserTabs caps restored tabs at 20 and comments that restoration creates WebContentsViews/page loads (pkg/sulla-desktop/composables/useBrowserTabs.ts:104-110); agent-origin tabs are capped at 10 (:195-199). This signals startup pressure, not measured memory. Instrument renderer PID, private/working set, CPU deltas, mode, visibility, idle time and main/GPU totals. Compare cold start, switching, background idle and restore with medians/p95.

## 2. Options compared

These are engineering estimates, not measurements.

| Dimension | A — Lazy-load + hibernate/discard in shared renderer | B — Every internal tab gets a WebContentsView renderer | C — Hybrid: process only measured-heavy tabs |
|---|---|---|---|
| Memory / CPU | Lowest-cost first win. Lazy loading is partly done. Unmounting a tab body can stop its timers and release DOM/object graphs, but the shared renderer baseline, module cache and app store remain. | Strongest per-tab reclamation/accounting. Each cold tab also pays a Chromium/V8/DOM baseline; many light tabs can cost more total. Independent scheduling helps isolation but doesn't make work free. | Preserves shared baseline for light tabs; reclaims heavy heaps. Likely best trade if telemetry sets a cap on concurrent heavy processes. |
| Crash isolation / kill one tab | Can remount one page, but cannot kill its OS renderer without killing siblings and shell. | Dedicated WebContents can be destroyed/recreated after crash; shell and sibling renderers survive. Main process/services remain shared. | True kill/restart for selected heavy tabs only; other tabs still share window crash domain. |
| State | Lowest cost: descriptor and current store remain; remount from IDs. Dirty drafts and background jobs need explicit policy. | Highest cost: Vuex/Pinia state isn't shared across JS heaps. Need versioned tab descriptors, IPC/repositories and restore protocol. Current AgentStateClient is per app renderer; avoid accidental N redundant clients. Chat identity survives via metadata/local persistence but in-memory UI doesn't transfer automatically. | Same protocol only for extracted surfaces; lightweight tabs keep existing store. Establish descriptor/snapshot contract once. |
| Tear-off (#2651) | Existing transfer flow mostly remains; include hibernation/draft state. | BrowserTabViewManager already moves native WebContentsViews without replacing WebContents, but #2651's release/adopt handshake transfers renderer tab descriptors and transient state. Moving internal surface view and its UI state atomically is new work. | Extend #2651 ownership abstraction for selected modes; test attach/detach, crash and dirty state. |
| Preload / IPC security | No new boundary, but checkpointing must not persist unsafe data/secrets. | More boundaries and IPC. Agent BrowserWindow currently has nodeIntegration:true, contextIsolation:false, webSecurity:false (window/index.ts:217-223); do not inherit these into tab renderers. Use dedicated narrow preload, contextIsolation:true, nodeIntegration:false, webSecurity:true, validate sender/frame and allowlist channels. | Same for process-backed modes. Security hardening is prerequisite, not automatic benefit. External browser WebContentsViews already use nodeIntegration:false and webSecurity:true but contextIsolation:false (browserTabViewManager.ts:357-375). |
| Startup / first-open | Async chunks can improve shell startup; hibernated remount/refetch adds wake latency. | Shell can stay small; each tab first-open pays process/preload/Vue/store/data startup. | Cost paid only by heavy modes. |
| Effort in mergeable PRs | Small–medium, roughly 2–4: instrumentation, async-loading cleanup, hibernate + restore. | Large, roughly 6–10+: host abstraction, secure IPC, state extraction, transfer, crash recovery and migration of each mode. | Medium–large, roughly 4–7: measurement, host/protocol, one pilot, then separately migrate justified modes. |

A is the best first experiment, but it cannot satisfy “kill one internal tab's process.” B is the literal process-per-tab answer but carries major state, security, IPC and baseline costs. C is recommended. Benchmark Chat (long-lived and #2692 already targeted its growth), Files/editor (Monaco), Workflows canvas and Docker UI before choosing. Do not assume Chat dominates. Docker UI renderer reclamation does not stop containers or reclaim daemon memory.

## 3. Recommended plan

Every phase is an independently mergeable PR; stop if measurements do not justify the next layer.

### Phase 0 — Baseline diagnostics (PR 1)

Add opt-in developer diagnostics at the main-process window/tab registry boundary: renderer PID/process type, tab ID/mode/owner, visibility and lifecycle timestamps; Electron app.getAppMetrics() memory and CPU deltas; JS heap only when supported. Avoid URLs, file paths, chat text, tokens and credentials.

**Acceptance:** accurately map internal and external tabs across windows and tear-off; explicitly identify unavailable metrics; document a same-machine protocol for cold start, 10 idle tabs, 20 restored tabs and open/close/switch. No MB target until baseline exists.

### Phase 1 — Stop hidden-tab idle work (PR 2)

Audit timers, polling, subscriptions, observers, workers and reactive loops under BrowserTab. Gate nonessential refresh on visibility, use explicit activation/deactivation and dispose listeners. Preserve main-process jobs that should continue while UI is hidden. Fill async chunking gaps only where appropriate.

**Acceptance:** focused behavior tests show hidden surfaces stop idle refresh and resync on return without duplicating subscriptions; hiding a tab does not cancel active turns/jobs. Measure CPU/working-set change.

### Phase 2 — Same-renderer hibernate/discard (PR 3)

Introduce per-tab lifecycle state distinct from mode/navigation. Start with opt-in/manual hibernate, then measured idle policy. Unmount heavy mode bodies but retain tab descriptor. Rehydrate via stable thread/file/workflow/container-view identity. Checkpoint dirty drafts or refuse hibernation. Preserve active work outside presentation renderer.

**Acceptance:** each pilot mode restores selected entity and safe draft state; missing backing data is recoverable; active work is not lost/duplicated; listeners and component trees are released. Label this component teardown, not process kill.

### Phase 3 — Secure first-party process-backed tab host (PR 4)

Create main-process InternalTabHost for dedicated first-party WebContentsViews, PID/lifecycle/focus ownership, crash/close handling and explicit IPC. Keep shell in current BrowserWindow renderer. Give tab renderer a narrow preload with contextIsolation:true, nodeIntegration:false, webSecurity:true and typed, allowlisted IPC. Prototype one diagnostic/sample surface only.

**Acceptance:** sample tab PID differs from shell/sibling; killing/crashing it leaves shell and sibling usable and tab recreatable; unauthorized sender/frame IPC is rejected; no general Node/electron object leaks; browser session policy remains separate.

### Phase 4 — One measured-heavy pilot (PR 5)

Move the single mode justified by Phase 0 behind the host. Keep services/data access in repositories/main process; pass capabilities and versioned descriptors rather than relying on shared in-memory store. Model restart from descriptor, not presumed continuation of ephemeral JS.

**Acceptance:** success/error/reload/dirty state tests; tear-off/return preserves documented selection and draft semantics; process kill leaves sibling/shell alive; telemetry shows net savings over shared-renderer baseline. Feature-flag rollout until repeated cold/idle/transfer samples agree.

### Phase 5 — Expand by evidence + task manager (PR 6+)

Migrate surfaces individually only when measurements justify them. Add a developer-facing Tab Processes panel alongside the process-backed pilot. Show non-sensitive mode/title, window, PID/type, visibility/lifecycle, RSS/working set where available, JS heap where supported and recent CPU delta. Offer Hibernate for tabs with restore contracts and Kill & Reopen only for dedicated renderers. Shared-renderer tabs should say “Reload tab,” never claim their process was independently killed. Warn if dirty state may be lost.

**Acceptance:** rows map to live WebContents/PID and follow transfer, crash, hibernate and close; stale PIDs are not shown as live; actions cannot target main/GPU/another tab; dirty warnings are accurate; panel does not poll constantly while closed. Compare representative light/heavy mixes with Phase 0 baseline.

## 4. Decisions required before implementation

- **State source of truth:** retain stable tab descriptors in shared/main-process durable state keyed by tabId and windowKey. Renderer stores become caches, not cross-process state.
- **Mode snapshot contract:** versioned serializable state, safe-to-persist fields, dirty checkpoint rules, and rehydration owner. Never transfer secrets or untrusted HTML merely because a process boundary exists; current persistence deliberately strips raw HTML (useBrowserTabs.ts:175-180).
- **AgentStateClient:** one client per renderer today (entry/agent.ts:53-58; AgentStateClient.ts:22-52,61-83). Choose a main-process broker/fan-out or accept one per process and measure; don't make each tab independently poll global state.
- **Tear-off:** retain #2651 release → target-ready → adopt → move → activate/rollback lifecycle (main/tabs/TabTransferService.ts:106-134). BrowserTabViewManager.moveViewToWindow moves an existing view across windows (:474-499); that is precedent, not proof that internal Vue/Pinia state already transfers.
- **Security:** context/process isolation alone is not security. Trusted app windows currently have broad Node/IPC settings (window/index.ts:217-223). Separate trusted app and external page policies, validate WebContents/frame at each IPC boundary, and never copy broad BrowserWindow preferences into content views.
- **Side effects:** external pages share persist:sulla-browser today (browserTabViewManager.ts:76-83); do not share it accidentally with internal app renderers. Terminal, Docker, workflows and chat operations may outlive presentation; killing UI must not silently stop or duplicate them.
- **Meaning of discard:** distinguish UI hibernate (unmount), renderer restart, and WebContents destruction. Name UI actions honestly and exempt tabs with required ongoing work.

## 5. Source map

- pkg/sulla-desktop/window/index.ts:81-93,200-224 — BrowserWindow creation/preferences.
- pkg/sulla-desktop/entry/agent.ts:39-64 — one Vue app/store and AgentStateClient per agent renderer.
- pkg/sulla-desktop/pages/AgentRouter.vue:47-77 — keep-alive and persistent hidden BrowserTab instances.
- pkg/sulla-desktop/pages/BrowserTab.vue:196-393,396-435,472-478 — mode branches, imports and current mode.
- pkg/sulla-desktop/pages/BrowserTab.vue:930-956,1125-1159 — external view creation and visibility lifecycle.
- pkg/sulla-desktop/window/browserTabViewManager.ts:76-103,331-385,474-499,562-581 — per-WebContents renderer, session, focus and window transfer.
- pkg/sulla-desktop/main/tabs/TabTransferService.ts:106-134 — multi-window transfer/rollback.
- pkg/sulla-desktop/composables/useBrowserTabs.ts:104-110,161-180,195-199 — restore limits and persisted/transient fields.
- pkg/sulla-desktop/services/agentState/AgentStateClient.ts:22-52,61-83 — renderer-owned state client.
- Git history: 85753a966 (#2651, multi-window tear-off); 32ba0cb2a (#2692, long-session chat renderer growth).
