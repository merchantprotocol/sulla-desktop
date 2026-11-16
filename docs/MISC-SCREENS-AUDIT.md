# Miscellaneous screens audit — PR #2266 recovery

2026-11-13 · sulla-desktop/recover-2266

**Status: source audit and confirmed defect fixes complete; parent review pending.** This is a source-traced inventory, not a live UI
acceptance report. No recording, publishing, sharing, deletion, or other live
mutation was exercised. No wallet data was accessed. Preferences, Live Agents,
Docker and Use Cases coverage belongs to the already-merged screen audits and
is not repeated here. Paths below are relative to pkg/sulla-desktop/.

## Control inventory and evidence

| Surface / controls | Source path / destination | Evidence and remaining gap |
|---|---|---|
| Workflows: load/refresh | pages/RoutinesHome.vue loadAll → composables/useRoutines.ts load → workflow-db-list | Read errors now surface in page feedback; source-only. |
| Workflows: duplicate | RoutinesHome onDuplicate → useRoutines duplicate → workflow-duplicate | Success ID/error feedback; source-only. |
| Workflows: archive / restore | RoutinesHome onToggleArchive/onRestoreRoutine → useRoutines toggleArchive → workflow-move → main/sullaWorkflowEvents.ts | Recovery checks success envelope and refresh error. Six isolated behavioral cases cover archive, restore, declined/rejected move, failed refresh and missing ID. No live mutations. |
| Workflows: export | RoutinesHome onExport → routines-export | Reads canceled/error/path envelope; does not claim a canceled export succeeded. Source-only. |
| Workflow editor: publish / draft | pages/AgentRoutines.vue togglePublished → workflow-move | Checks success and presents rejected errors. Source-only, no publication exercised. |
| Workflow editor: save state | AgentRoutines persistence status | Error text/title exposed; persistence integration unverified. |
| Workflow editor: Inspect output | AgentRoutines onNodeCtxInspectOutput → run mode → selectedNodeId | Replaces console stub with output drawer selection; live output unverified. |
| Main menu: workflow import/export/template export | main/mainmenu.ts sendAgentCommand → pages/AgentRouter.vue onAgentCommand → routines-* IPC | Result error/rejection now alerts; cancel remains quiet. Source-only. |
| Main menu: update channel/version | main/mainmenu.ts updateChannelLabel → updateManager.getState / Electron.app.getVersion | Removes stale hard-coded version. Native menu rendering unverified. |
| History: search/filter/view/open | pages/HistoryTab.vue debouncedSearch/loadHistory/openEntry → conversation-history:list / tab create or restore | Source-connected. Same-context refresh failures retain prior rows; changed view/filter/query failures clear stale rows and show a retryable error; real search failures now propagate through IPC. |
| History: rename / pin / unread / archive / undo / restore | HistoryTab patchEntry → conversation-history:update | Rejected/missing mutations now show an inline error. Archive undo remains available after failed undo; its success label now reflects the action correctly. |
| History: delete confirmation / clear hour,today,all | HistoryTab confirmDelete/deleteConfirmed/deleteEntry/clearHistory → update or conversation-history:clear | Confirmation exists. Delete errors flow through patchEntry; clear now uses an acknowledged invoke handler and reloads only after success. Legacy fire-and-forget callers remain compatible. Not executed live. |
| History: share / copy | HistoryTab disabled Sharing unavailable affordance | Disabled with explanation: existing Cloud API enrolls conversations for device sync, not public read-only sharing. Removed the misleading dialog, inert include-tool-output toggle, Cloud invocation and copy path. No device URL/token can be generated or copied from History. |
| Secretary: start / mute / end / choose again | pages/SecretaryMode.vue startSession/toggleMute/endSession/resetAndChoose → controller | Start failure has visible startError; session/media paths not live-tested. |
| Secretary: send / notes save / reveal | SecretaryMode sendChatMessage/saveNotes/revealNotes → controller / secretary-mode:save-notes,reveal-notes | Save result checks ok/error with notesStatus. Reveal now checks ok and shows rejected/declined operations in the Secretary notice. No capture or notes written. |
| Capture Studio: source/layout/shape/swap/teleprompter/tracks | pages/CaptureStudio.vue → FloatingControls, LayoutBar, CameraBubble, TeleprompterLayout handlers | Event wiring inventoried; child controls and hardware lifecycle still need deeper review/live permission-safe acceptance. |
| Capture Studio: display/window/area, mic/camera, record/cancel | CaptureStudio setup controls → selectSetupMode/startSetupRecording | Disabled without source or while starting. Capture path not exercised. |
| Capture Studio: screenshot/record, playback/pause/close/open folder | CaptureStudio doScreenshot/toggleRecord/startInlinePlayback/playAllStreams/pauseAllStreams/closePlayback/openSessionFolder | Source-connected only; file/media/runtime acceptance pending. |
| Browser chrome: back/forward/reload/stop/address | pages/BrowserTab.vue goBack/goForward/reload/stop/navigate → browser-tab-view:* | Back/forward/reload/stop, browser creation/positioning and existing-view address navigation now catch rejections and present dismissible inline feedback; loading resets on failure. |
| Browser chrome: bookmark | BrowserTab onStarClick → useBookmarks addBookmark → reveal event | Bookmark failure now shows dismissible inline feedback. Blank workflow creation errors use the same notice. |
| Composer: attach/remove/send/stop | pages/agent/AgentComposer.vue triggerFileInput/handleFileSelect/removeAttachment / send,stop emits | Source-connected. Unsupported file types and FileReader errors now show non-blocking attachment feedback. Parent send lifecycle is source-traced, not live-accepted. |
| Composer: model/default/agent choices, voice/TTS | AgentComposer modelSelector / toggleRecording / stopTTS | Source-connected only; menu persistence and audio lifecycle pending. |
| Left rail: modes, extension menu, file explorer | pages/chat/components/chrome/ModeRail.vue select/extension actions/toggle-chat-files emits | Component event wiring exists; parent handlers, extension permissions/removal and all footer controls not fully audited. |
| Main menu: new tabs, integrations, vault, Use Cases, Edit, Inspect, Support, Help, History | main/mainmenu.ts getFileMenu/getInspectMenu/getSupportMenu / role items / command dispatch | Source-connected inventory only; no vault inspection and no support message sent. Per-item native acceptance pending. |

## Recovery validation

- Clean inherited worktree/head before edits: 62a497000eeaf6073ab0ecf9c03072bda1d6e434.
- No active miscellaneous-screen owner appeared in the fleet job listing.
- License-header scan passed (4,255 tracked files before recovery additions).
- Targeted tests: 19/19 passed across archive/restore, actual History/Secretary/browser action bodies, and registered History IPC handlers. Tests use injected synthetic contexts, not a mounted/live UI.
- Seven changed Vue SFCs compiled with @vue/compiler-sfc and their generated TypeScript transpiled with esbuild. This is not a full application build.
- App build attempted; blocked before compilation by missing worktree build
  dependencies. No full dependency install, host changes, app restart/install,
  typecheck, or broad test suite.
- Merged origin/main 24c7e71d7 into this branch as 8d9b25500. Resolved overlapping routines changes preserving guarded archive success, export outcome handling, page feedback and main changes. No unmerged paths remain. Parent must review the resulting diff before shipping.

## Scope decision and undo

Recovery fixes confirmed source defects without redesigning the product or inventing a public-share API. Hardware-dependent capture/audio, parent event dispatch and native menu behavior remain live-unverified; these are validation limits, not known product decisions needed from Jonathon. No remaining confirmed source defect from this inventory is intentionally left unfixed.

Undo recovery commits with git revert; inherited PR fixes and the main integration remain explicit commits. Parent owns final review, publication and merge. Keep draft until that review is complete.
