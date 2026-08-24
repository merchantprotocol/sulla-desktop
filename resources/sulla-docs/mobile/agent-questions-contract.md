# Agent Questions — mobile inbox & unblock-decision contract

Task PGti / epic x4aG (Mobile question and decision interface).

## Problem

`ask_user_question` (`agent/tools/meta/ask_user_question.ts`) pauses an agent
and parks a Promise in `ApprovalService` (`parkQuestion` -> `resolveQuestion`).
That promise is **in-memory only**: a desktop restart loses every pending
prompt, and there is no surface a phone can read or answer. This contract adds
a durable store so questions survive restart, appear in a mobile inbox, are
answerable from any transport, are deduplicated while pending, and route back
to the originating orchestration thread.

## Data model — `agent_questions` (migration 0078)

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | the ApprovalService `questionId` (`quest_<ts>_<rand>`) |
| `conversation_id` | TEXT | originating thread |
| `task_id` | TEXT? | originating Projects task, when known |
| `agent` | TEXT? | asking agent / persona |
| `kind` | TEXT | `decision` \| `dependency` \| `test` — foreground true human decisions |
| `title` | TEXT? | short card header |
| `context` | TEXT? | why the agent is asking |
| `recommendation` | TEXT? | the agent's recommended option |
| `risk` | TEXT? | risk / impact summary |
| `questions` | JSONB | the `UserQuestion[]` payload (question, options, multiSelect) |
| `status` | TEXT | `pending` \| `answered` \| `expired` \| `superseded` \| `cancelled` |
| `answers` | JSONB? | `UserQuestionAnswerItem[]` once answered |
| `answered_by` / `answered_via` | TEXT? | who answered / `desktop`\|`mobile` |
| `dedup_fingerprint` | TEXT | sha256 of normalized {conversation, kind, questions} |
| `timeout_ms` / `expires_at` | INT? / TS? | original timeout window |
| `created_at` / `updated_at` / `answered_at` | TS | lifecycle stamps |

**Dedup:** partial unique index `(dedup_fingerprint) WHERE status='pending'` —
at most one live prompt per fingerprint, so a retrying agent never stacks
duplicate questions on the human. `AgentQuestionModel.record()` is idempotent
per live fingerprint (returns the existing pending row, `created:false`).

**`kind`** lets the inbox separate a genuine human decision from a dependency
wait or a test/sleep-window event (acceptance note FirP).

## API surface

`AgentQuestionModel` (durable CRUD): `fingerprint`, `record`, `answer`
(fail-closed on stale/double submit), `getById`, `listPending`,
`listByConversation`, `expire`, `supersedePending`.

`AgentQuestionRegistry` (transport seam):
- `recordAsk(input)` — persist on ask (best-effort, non-fatal).
- `onResolved(id, answers, via)` — persist a desktop-routed answer.
- `onTimeout(id)` — persist a timeout.
- `submitAnswer(id, answers, {answeredBy, answeredVia})` — the mobile path:
  resolve the live parked promise (resume the thread) **and** persist. Returns
  `{ routedLive, persisted, question }`.
- `listInbox(limit)` / `getQuestion(id)` — inbox feed.

### Answer routing & offline-safety

`submitAnswer` calls `ApprovalService.resolveQuestion(id, answers)` first so the
originating thread continues immediately. It then persists via
`AgentQuestionModel.answer`, which only transitions `pending -> answered`, so a
double submit or a stale answer is rejected (`ok:false`). If the desktop
restarted and the parked promise is gone (`routedLive:false`), the answer is
still durably recorded and the thread's resume path reads the answered row.

## Wiring (follow-up increment)

This PR lands the additive backbone (schema + model + registry + tests + doc).
The two hooks that populate it in production are intentionally small and
separate so they can be reviewed against the live in-memory path:

1. `agent/tools/meta/askUserQuestionShared.ts` — after `newQuestionId()` and
   before returning, call `AgentQuestionRegistry.recordAsk({ id, conversationId,
   questions, agent, taskId, timeoutMs })`.
2. `ApprovalService.resolveQuestion` (or its `question:resolve` IPC handler) —
   after a successful resolve, call `AgentQuestionRegistry.onResolved(id,
   answers, 'desktop')`; on timeout call `onTimeout(id)`.

## Mobile surface (follow-up increments)

- **Agent tools** under `agent/tools/mobile/`: `list_questions`, `get_question`,
  `answer_question` (thin wrappers over `AgentQuestionRegistry`), registered in
  `agent/tools/mobile/manifests.ts`.
- **Inbox/card UI**: each card shows context, recommendation, options,
  risk/impact, originating thread/task, and an answer action; pending questions
  persist across sessions; answer submission is retryable and offline-safe.
- **Push / deep-link**: a new pending `decision` emits a push whose deep link
  opens the specific question card (`sulla://questions/<id>`), reusing
  `main/deepLink.ts` and the existing relay (`main/desktopRelay.ts`).
- **Accessibility**: options are a labelled radio/checkbox group; cards are
  focus-navigable; recommendation and risk are announced; answer action has an
  accessible name and a busy/retry state.
- **End-to-end**: ask -> persisted pending -> mobile inbox -> answer -> live
  thread resume; restart mid-pending -> still answerable; duplicate re-ask ->
  single card.
