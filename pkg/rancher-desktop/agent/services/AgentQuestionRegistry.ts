import { ApprovalService, type UserQuestionAnswerItem } from './ApprovalService';
import {
  AgentQuestionModel,
  type AgentQuestionChannel,
  type AgentQuestionRecord,
  type RecordQuestionInput,
} from '../database/models/AgentQuestionModel';

/**
 * AgentQuestionRegistry — the seam between the ephemeral, in-memory question
 * primitive (ApprovalService) and the durable store (AgentQuestionModel).
 *
 * It exists so the ask/answer lifecycle can be persisted and answered from a
 * mobile inbox without coupling ApprovalService to Postgres. All persistence
 * here is best-effort: a database hiccup must never break the working desktop
 * chat path, so record/resolve hooks swallow their errors (logged, non-fatal),
 * while the mobile-facing submit path surfaces the persisted outcome.
 *
 * Wiring (follow-up increment, see the mobile contract doc):
 *   - askUserQuestionShared: call `recordAsk(...)` right after `newQuestionId()`.
 *   - ApprovalService.resolveQuestion / its IPC handler: call `onResolved(...)`.
 */
export interface SubmitAnswerOptions {
  answeredBy?:  string | null;
  answeredVia?: AgentQuestionChannel;
}

export interface SubmitAnswerResult {
  /** true when a live parked promise matched and its thread was resumed. */
  routedLive: boolean;
  /** true when the durable row transitioned pending -> answered. */
  persisted:  boolean;
  question:   AgentQuestionRecord | null;
}

export class AgentQuestionRegistry {
  /** Persist a freshly-asked question. Non-fatal on failure. */
  static async recordAsk(input: RecordQuestionInput): Promise<AgentQuestionRecord | null> {
    try {
      const { question } = await AgentQuestionModel.record(input);
      return question;
    } catch (err) {
      console.warn('[AgentQuestionRegistry] recordAsk failed (non-fatal):', err);
      return null;
    }
  }

  /** Persist a resolution that already settled the in-memory promise (e.g. a
   *  desktop chat answer routed through ApprovalService). Non-fatal. */
  static async onResolved(
    id: string,
    answers: UserQuestionAnswerItem[],
    via: AgentQuestionChannel = 'desktop',
  ): Promise<void> {
    try {
      await AgentQuestionModel.answer(id, { answers, answeredVia: via });
    } catch (err) {
      console.warn('[AgentQuestionRegistry] onResolved persist failed (non-fatal):', err);
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
   * Submit an answer from a mobile client. Routes to the live parked promise
   * first so the originating orchestration thread resumes immediately, then
   * durably records the answer. Offline-safe: if the desktop restarted and the
   * parked promise is gone (`routedLive === false`), the answer is still
   * persisted and the thread's resume path reads the answered row.
   */
  static async submitAnswer(
    id: string,
    answers: UserQuestionAnswerItem[],
    opts: SubmitAnswerOptions = {},
  ): Promise<SubmitAnswerResult> {
    const routedLive = ApprovalService.getInstance().resolveQuestion(id, answers);
    const result = await AgentQuestionModel.answer(id, {
      answers,
      answeredBy:  opts.answeredBy ?? null,
      answeredVia: opts.answeredVia ?? 'mobile',
    }).catch((err): { ok: boolean; question: AgentQuestionRecord | null } => {
      console.warn('[AgentQuestionRegistry] submitAnswer persist failed:', err);
      return { ok: false, question: null };
    });
    return { routedLive, persisted: result.ok, question: result.question };
  }

  /** Mobile inbox feed: pending questions, newest first. */
  static listInbox(limit = 50): Promise<AgentQuestionRecord[]> {
    return AgentQuestionModel.listPending(limit);
  }

  static getQuestion(id: string): Promise<AgentQuestionRecord | null> {
    return AgentQuestionModel.getById(id);
  }
}
