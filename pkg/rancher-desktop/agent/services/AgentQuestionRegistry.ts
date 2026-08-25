import { ApprovalService, type UserQuestionAnswerItem } from './ApprovalService';
import {
  AgentQuestionModel,
  DEFAULT_PROFILE_ID,
  type AgentQuestionChannel,
  type AgentQuestionRecord,
  type RecordQuestionInput,
  type RecordQuestionResult,
} from '../database/models/AgentQuestionModel';

/**
 * AgentQuestionRegistry — the seam between the ephemeral, in-memory question
 * primitive (ApprovalService) and the durable store (AgentQuestionModel).
 *
 * It exists so the ask/answer lifecycle is persisted and answerable from a
 * mobile inbox without coupling ApprovalService to Postgres.
 *
 * Invariants:
 *  - CANONICAL ID: `recordAsk` may deduplicate onto an older pending row.
 *    Callers must take the returned row's id as the question id for the
 *    emitted card, the parked promise, and timeout bookkeeping.
 *  - CLAIM-THEN-RESOLVE: every path that resumes a live parked promise first
 *    claims the durable row (pending -> answered, atomic) and only resumes on
 *    a successful claim. A crash between the two, or a concurrent double
 *    answer, can therefore never double-resume the asking thread.
 *  - SCOPE: the answerer-facing read/answer surface is profile-scoped; an
 *    answerer only sees/settles questions whose profile matches their scope.
 *
 * Ask-side persistence stays best-effort: a database hiccup must never break
 * the working desktop chat path, so `recordAsk` swallows its errors (logged,
 * non-fatal) and the ask falls back to the purely in-memory lifecycle.
 */
export interface SubmitAnswerOptions {
  /** Answerer scope — only questions in this profile are answerable. */
  profileId?:   string;
  answeredBy?:  string | null;
  answeredVia?: AgentQuestionChannel;
}

export interface SubmitAnswerResult {
  /** true when a live parked promise matched and its thread was resumed. */
  routedLive: boolean;
  /** true when THIS submit transitioned the durable row pending -> answered. */
  persisted:  boolean;
  question:   AgentQuestionRecord | null;
  /** Why the submit did not persist, when it didn't. */
  reason?:    'not_found' | 'already_settled' | 'store_error';
}

export interface QuestionReadOptions {
  profileId?: string;
  limit?:     number;
}

export interface ResumeReport {
  reparked: number;
  expired:  number;
  failed:   number;
}

/** Emit (or re-emit) a question card over the chat WebSocket pipeline. */
async function emitCard(question: AgentQuestionRecord): Promise<boolean> {
  // Late import keeps module load order light and avoids dragging the WS
  // client into unit tests that only exercise persistence.
  const { emitQuestionCardViaWs } = await import('../tools/meta/askUserQuestionShared');
  return emitQuestionCardViaWs(undefined, question.conversation_id, question.id, question.questions);
}

export class AgentQuestionRegistry {
  /**
   * Persist a freshly-asked question. Non-fatal on failure (returns null and
   * the caller proceeds with the in-memory-only lifecycle).
   *
   * On success the caller MUST adopt `result.question.id` as the canonical
   * question id — when `created` is false the ask deduplicated onto an older
   * pending row and the freshly generated id does not exist anywhere.
   */
  static async recordAsk(input: RecordQuestionInput): Promise<RecordQuestionResult | null> {
    try {
      return await AgentQuestionModel.record(input);
    } catch (err) {
      console.warn('[AgentQuestionRegistry] recordAsk failed (non-fatal):', err);
      return null;
    }
  }

  /** Persist a timeout with no answer. Non-fatal. */
  static async onTimeout(id: string): Promise<void> {
    try {
      await AgentQuestionModel.expire(id);
    } catch (err) {
      console.warn('[AgentQuestionRegistry] onTimeout persist failed (non-fatal):', err);
    }
  }

  /**
   * Settle a question answered on the DESKTOP surface (ToolQuestion card ->
   * `question:resolve` IPC). Claim-then-resolve:
   *
   *  - durable row claimed        -> resume the parked promise
   *  - durable row already settled -> do NOT resume (stale/double submit)
   *  - no durable row              -> legacy in-memory question (recordAsk
   *    failed or pre-migration) — resume the parked promise as before
   *  - store unreachable           -> resume anyway; the desktop chat path
   *    must keep working without Postgres (row stays pending and is
   *    reconciled by restart replay / expiry)
   *
   * The desktop surface is the machine owner's own UI, so no profile scope is
   * applied here — scoping guards the remote/mobile surface.
   */
  static async resolveFromDesktop(id: string, answers: UserQuestionAnswerItem[]): Promise<{ settled: boolean; reason?: string }> {
    let claimed = false;
    let rowKnown = false;
    try {
      const result = await AgentQuestionModel.answer(id, { answers, answeredVia: 'desktop' });
      claimed = result.ok;
      rowKnown = result.question !== null;
    } catch (err) {
      console.warn('[AgentQuestionRegistry] desktop answer persist failed (continuing in-memory):', err);
    }

    if (rowKnown && !claimed) {
      // The durable row exists and something already settled it — refuse to
      // resume the promise a second time.
      return { settled: false, reason: 'already_settled' };
    }

    const settled = ApprovalService.getInstance().resolveQuestion(id, answers);
    return { settled };
  }

  /**
   * Submit an answer from the mobile surface. Strict claim-then-resolve:
   * the durable row is claimed (pending -> answered, scope-checked) FIRST and
   * the live parked promise is resumed only on a successful claim, so a crash
   * mid-submit or a concurrent double answer can never double-resume the
   * asking thread. Offline-safe: if the desktop restarted and the parked
   * promise is gone (`routedLive:false`), the answer is still durably
   * recorded and restart replay / the resume path reads the answered row.
   *
   * The mobile surface only ever answers questions it can see in its scoped
   * inbox, so an id with no visible durable row is rejected outright — never
   * routed to the live promise (that would bypass the authorization scope).
   * A store error is returned as retryable, with no state change anywhere.
   */
  static async submitAnswer(
    id: string,
    answers: UserQuestionAnswerItem[],
    opts: SubmitAnswerOptions = {},
  ): Promise<SubmitAnswerResult> {
    const profileId = opts.profileId ?? DEFAULT_PROFILE_ID;
    let claim: { ok: boolean; question: AgentQuestionRecord | null };
    try {
      claim = await AgentQuestionModel.answer(id, {
        answers,
        answeredBy:  opts.answeredBy ?? null,
        answeredVia: opts.answeredVia ?? 'mobile',
      }, { profileId });
    } catch (err) {
      console.warn('[AgentQuestionRegistry] submitAnswer persist failed (retryable):', err);
      return { routedLive: false, persisted: false, question: null, reason: 'store_error' };
    }

    if (!claim.ok) {
      return {
        routedLive: false,
        persisted:  false,
        question:   claim.question,
        reason:     claim.question ? 'already_settled' : 'not_found',
      };
    }

    const routedLive = ApprovalService.getInstance().resolveQuestion(id, answers);
    return { routedLive, persisted: true, question: claim.question };
  }

  /** Mobile inbox feed: pending questions in the answerer's scope, newest first. */
  static listInbox(opts: QuestionReadOptions = {}): Promise<AgentQuestionRecord[]> {
    return AgentQuestionModel.listPending({ profileId: opts.profileId ?? DEFAULT_PROFILE_ID }, opts.limit ?? 50);
  }

  static getQuestion(id: string, opts: QuestionReadOptions = {}): Promise<AgentQuestionRecord | null> {
    return AgentQuestionModel.getById(id, { profileId: opts.profileId ?? DEFAULT_PROFILE_ID });
  }

  /**
   * Restart resumption. After a desktop restart every parked promise is gone,
   * but pending rows survive in `agent_questions`. For each machine-wide
   * pending row this:
   *
   *  - expires rows whose original timeout window already elapsed,
   *  - re-parks a promise under the SAME question id (so both answer surfaces
   *    route exactly as before the restart), with the REMAINING timeout, and
   *  - re-emits the question card to the chat surface so the human can see
   *    what is still waiting on them.
   *
   * The re-parked promise has no tool caller awaiting it — its job is to
   * restore the live answer route and timeout bookkeeping. When it settles
   * as timed_out the row is expired; when it settles as answered the
   * claim-then-resolve surfaces have already persisted the answer.
   */
  static async resumePendingAfterRestart(limit = 200): Promise<ResumeReport> {
    const report: ResumeReport = { reparked: 0, expired: 0, failed: 0 };
    let pending: AgentQuestionRecord[];
    try {
      pending = await AgentQuestionModel.listPending(null, limit);
    } catch (err) {
      console.warn('[AgentQuestionRegistry] restart replay: listPending failed:', err);
      report.failed += 1;
      return report;
    }

    const service = ApprovalService.getInstance();
    for (const question of pending) {
      try {
        const expiresAtMs = question.expires_at ? Date.parse(question.expires_at) : NaN;
        if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
          await AgentQuestionModel.expire(question.id);
          report.expired += 1;
          continue;
        }

        // Remaining window, floored so a question a moment from expiry still
        // gets a beat to be answered; no expires_at means the original ask
        // had no timeout recorded — fall back to the standard 5 minutes.
        const remainingMs = Number.isFinite(expiresAtMs)
          ? Math.max(15_000, expiresAtMs - Date.now())
          : 5 * 60 * 1000;

        service.parkQuestion(question.id, remainingMs)
          .then((resolution) => {
            if (resolution.status === 'timed_out') return AgentQuestionRegistry.onTimeout(question.id);
            // Answered: whichever surface resolved it already claimed the row.
            return undefined;
          })
          .catch(() => { /* park never rejects; defensive */ });

        await emitCard(question).catch(() => false);
        report.reparked += 1;
      } catch (err) {
        console.warn(`[AgentQuestionRegistry] restart replay failed for ${ question.id }:`, err);
        report.failed += 1;
      }
    }

    if (report.reparked || report.expired || report.failed) {
      console.log(`[AgentQuestionRegistry] restart replay: re-parked ${ report.reparked }, expired ${ report.expired }, failed ${ report.failed }`);
    }
    return report;
  }
}
