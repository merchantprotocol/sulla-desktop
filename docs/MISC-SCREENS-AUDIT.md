# Miscellaneous screens audit — PR #2266 recovery

2026-11-13 · sulla-desktop/recover-2266

**Status: partial, draft.** This is a source-traced inventory, not a live UI
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
| History: search/filter/view/open | pages/HistoryTab.vue debouncedSearch/loadHistory/openEntry → conversation-history:list / tab create or restore | Source-connected. loadHistory catch hides failures as an empty list: **open gap**. |
| History: rename / pin / unread / archive / undo / restore | HistoryTab patchEntry → conversation-history:update | Source-connected, but rejected mutations lack visible feedback: **open gap**. |
| History: delete confirmation / clear hour,today,all | HistoryTab confirmDelete/deleteConfirmed/deleteEntry/clearHistory → update or conversation-history:clear | Confirmation exists. deleteEntry catches and ignores failures; clear uses delayed reload without acknowledged success: **open gaps**. Not executed. |
| History: share / copy | HistoryTab createShareLink/copyShareLink → sulla-cloud-chat:link / clipboard | Source-connected. Link failures lack visible error; includeToolOutput toggle is not passed to request: **open privacy/UX review**, do not exercise sharing until contract verified. |
| Secretary: start / mute / end / choose again | pages/SecretaryMode.vue startSession/toggleMute/endSession/resetAndChoose → controller | Start failure has visible startError; session/media paths not live-tested. |
| Secretary: send / notes save / reveal | SecretaryMode sendChatMessage/saveNotes/revealNotes → controller / secretary-mode:save-notes,reveal-notes | Save result checks ok/error with notesStatus. Reveal promise has no catch: **open gap**. No capture or notes written. |
| Capture Studio: source/layout/shape/swap/teleprompter/tracks | pages/CaptureStudio.vue → FloatingControls, LayoutBar, CameraBubble, TeleprompterLayout handlers | Event wiring inventoried; child controls and hardware lifecycle still need deeper review/live permission-safe acceptance. |
| Capture Studio: display/window/area, mic/camera, record/cancel | CaptureStudio setup controls → selectSetupMode/startSetupRecording | Disabled without source or while starting. Capture path not exercised. |
| Capture Studio: screenshot/record, playback/pause/close/open folder | CaptureStudio doScreenshot/toggleRecord/startInlinePlayback/playAllStreams/pauseAllStreams/closePlayback/openSessionFolder | Source-connected only; file/media/runtime acceptance pending. |
| Browser chrome: back/forward/reload/stop/address | pages/BrowserTab.vue goBack/goForward/reload/stop/navigate → browser-tab-view:* | Source-connected. Navigation invokes lack rejection UI: **open gap**. |
| Browser chrome: bookmark | BrowserTab onStarClick → useBookmarks addBookmark → reveal event | Failure is console-only: **open gap**. |
| Composer: attach/remove/send/stop | pages/agent/AgentComposer.vue triggerFileInput/handleFileSelect/removeAttachment / send,stop emits | Source-connected. Parent dispatch, file errors and send lifecycle not yet accepted. |
| Composer: model/default/agent choices, voice/TTS | AgentComposer modelSelector / toggleRecording / stopTTS | Source-connected only; menu persistence and audio lifecycle pending. |
| Left rail: modes, extension menu, file explorer | pages/chat/components/chrome/ModeRail.vue select/extension actions/toggle-chat-files emits | Component event wiring exists; parent handlers, extension permissions/removal and all footer controls not fully audited. |
| Main menu: new tabs, integrations, vault, Use Cases, Edit, Inspect, Support, Help, History | main/mainmenu.ts getFileMenu/getInspectMenu/getSupportMenu / role items / command dispatch | Source-connected inventory only; no vault inspection and no support message sent. Per-item native acceptance pending. |

## Recovery validation

- Clean inherited worktree/head before edits: 62a497000eeaf6073ab0ecf9c03072bda1d6e434.
- No active miscellaneous-screen owner appeared in the fleet job listing.
- License-header scan passed (4,255 tracked files before recovery additions).
- Targeted behavioral test result is reported in the parent handoff.
- App build attempted; blocked before compilation by missing worktree build
  dependencies. No full dependency install, host changes, app restart/install,
  typecheck, or broad test suite.
- PR currently conflicts with main. Parent must resolve/review against current
  main and rerun focused validation before any merge.

## Scope decision and undo

Recovery is intentionally bounded: prevent false archive/restore success and
preserve an honest remaining inventory instead of declaring all controls done.
Undo the recovery commit with git revert; inherited PR fixes remain separate.
Keep #2266 draft until open gaps are fixed or explicitly split and accepted.
