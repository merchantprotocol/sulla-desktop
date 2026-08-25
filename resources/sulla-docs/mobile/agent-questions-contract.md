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
| `profile_id` | TEXT | answerer scope, default `'default'` — every read/answer filters on it |
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

**Dedup & canonical id:** partial unique index `(profile_id, dedup_fingerprint)
WHERE status='pending'` — at most one live prompt per fingerprint per profile.
`AgentQuestionModel.record()` is a single atomic upsert (`ON CONFLICT … DO
UPDATE … RETURNING *`): it always returns exactly one row, either the fresh
insert (`created:true`) or the older pending row that deduplicated the ask
(`created:false`). **Callers must adopt the returned row's id as the canonical
question id** for the emitted card, the parked promise, and timeout
bookkeeping — both ask paths do this, so an answer from any surface routes to
the promise that is actually parked.

**Authorization scope:** `profile_id` follows the existing
`work_lane_workflow_bindings.profile_id` idiom. The answerer-facing surface
(`listInbox`, `getQuestion`, `submitAnswer`) filters every query on the
caller's profile; a question in another profile is indistinguishable from a
nonexistent one, and an out-of-scope answer is rejected before any state
changes and never routed to the live promise. The desktop `question:resolve`
IPC (the machine owner's own UI) is not profile-filtered.

**`kind`** lets the inbox separate a genuine human decision from a dependency
wait or a test/sleep-window event (acceptance note FirP).

## API surface

`AgentQuestionModel` (durable CRUD): `fingerprint`, `record` (atomic dedup
upsert), `answer` (atomic scoped claim, fail-closed on stale/double submit),
`getById`, `listPending`, `listByConversation` (scoped), `expire`,
`supersedePending`.

`AgentQuestionRegistry` (transport seam):
- `recordAsk(input)` — persist on ask (best-effort, non-fatal); returns the
  canonical row + `created` flag.
- `resolveFromDesktop(id, answers)` — desktop-routed answer, claim-then-resolve.
- `onTimeout(id)` — persist a timeout.
- `submitAnswer(id, answers, {profileId, answeredBy, answeredVia})` — the
  mobile path, claim-then-resolve. Returns `{ routedLive, persisted, question,
  reason? }`.
- `listInbox({profileId, limit})` / `getQuestion(id, {profileId})` — scoped
  inbox feed.
- `resumePendingAfterRestart()` — restart replay (below).

### Answer routing — claim-then-resolve

Every path that resumes a live parked promise **claims the durable row first**
(`AgentQuestionModel.answer` transitions `pending -> answered` atomically,
scope-checked) and resumes only on a successful claim. A concurrent double
answer or a crash mid-submit therefore can never double-resume the asking
thread: exactly one submit wins the claim; the loser gets
`reason:'already_settled'` and no side effects.

- Mobile (`submitAnswer`): strict. No visible durable row -> `not_found`
  (never routed live — that would bypass the authorization scope). Store
  error -> `store_error`, retryable, nothing changed anywhere.
- Desktop (`question:resolve` IPC -> `resolveFromDesktop`): claimed row ->
  resume; row already settled -> refuse to resume; **no durable row** (ask-side
  persistence failed) -> legacy in-memory resolve, and if the store is
  unreachable the desktop chat path still resolves in-memory — the pending row
  is reconciled later by restart replay or expiry.

Offline-safety: if the desktop restarted and no promise is parked
(`routedLive:false`), the answer is still durably recorded.

### Restart resumption

`AgentQuestionRegistry.resumePendingAfterRestart()` runs from the post-DB-boot
block in `main/sullaEvents.ts` (after workflow recovery). For every pending
row, machine-wide:

- rows whose `expires_at` already elapsed are marked `expired`;
- otherwise the promise is **re-parked under the same question id** with the
  remaining timeout window (floor 15s; 5 min when no expiry was recorded), so
  desktop and mobile answers route exactly as before the restart, and the
  question card is **re-emitted** to the chat surface
  (`emitQuestionCardViaWs`, `sulla-desktop` channel);
- when a re-parked promise times out the row is expired; when it is answered,
  the claim-then-resolve surfaces have already persisted the answer.

## Ask-path wiring (implemented)

1. `agent/tools/meta/ask_user_question.ts` (in-process tool): records via
   `recordAsk` right after `newQuestionId()`, adopts the canonical id, and
   persists timeouts after `parkQuestion` settles.
2. `main/MCPServerHost.ts` `ask_user_question` (claude-code's twin): same
   record -> canonical id -> emit -> park -> timeout persistence sequence.
3. `main/sullaApprovalEvents.ts` `question:resolve` IPC: routes through
   `resolveFromDesktop` (claim-then-resolve).

## Mobile surface (implemented: agent tools)

`agent/tools/mobile/`: `list_questions`, `get_question`, `answer_question` —
thin wrappers over `AgentQuestionRegistry`, registered in
`agent/tools/mobile/manifests.ts`. Mobile-originated chats already route
through the desktop agent loop (relay -> `mobile-relay` channel), so these
tools are callable from a phone conversation today, scoped to the caller's
profile.

## Remaining scope (follow-up increments)

- **Inbox/card UI** (native mobile client): each card shows context,
  recommendation, options, risk/impact, originating thread/task, and an
  answer action; pending questions persist across sessions; answer submission
  is retryable (`store_error` is the retry signal) and offline-safe.
- **Push / deep-link**: a new pending `decision` emits a push whose deep link
  opens the specific question card (`sulla://questions/<id>`), reusing
  `main/deepLink.ts` and the existing relay (`main/desktopRelay.ts`).
- **Accessibility**: options are a labelled radio/checkbox group; cards are
  focus-navigable; recommendation and risk are announced; answer action has an
  accessible name and a busy/retry state.
- **End-to-end**: ask -> persisted pending -> mobile inbox -> answer -> live
  thread resume; restart mid-pending -> still answerable; duplicate re-ask ->
  single card.
