import { createHash } from 'node:crypto';
import { postgresClient } from '../PostgresClient';
import type { UserQuestion, UserQuestionAnswerItem } from '../../services/ApprovalService';

/**
 * AgentQuestionModel — durable store for questions raised via
 * `ask_user_question`. Mirrors the ApprovalService in-memory question so a
 * pending prompt survives restart, is answerable from a mobile inbox, and is
 * deduplicated while still pending. See migration 0078 and
 * resources/sulla-docs/mobile/agent-questions-contract.md.
 *
 * `kind` distinguishes a true human decision from a dependency wait or a test
 * event, so the mobile inbox can foreground real decisions.
 *
 * `profile_id` is the authorization scope: every read/answer surface filters
 * on it, so an answerer only ever sees or settles questions scoped to them
 * (same idiom as work_lane_workflow_bindings.profile_id).
 */
export type AgentQuestionKind = 'decision' | 'dependency' | 'test';
export type AgentQuestionStatus = 'pending' | 'answered' | 'expired' | 'superseded' | 'cancelled';
export type AgentQuestionChannel = 'desktop' | 'mobile';

export const DEFAULT_PROFILE_ID = 'default';

/** Answerer scope. Reads/answers only touch rows whose profile matches. */
export interface QuestionScope {
  profileId: string;
}

export interface AgentQuestionRecord {
  id:                string;
  profile_id:        string;
  conversation_id:   string;
  task_id:           string | null;
  agent:             string | null;
  kind:              AgentQuestionKind;
  title:             string | null;
  context:           string | null;
  recommendation:    string | null;
  risk:              string | null;
  questions:         UserQuestion[];
  status:            AgentQuestionStatus;
  answers:           UserQuestionAnswerItem[] | null;
  answered_by:       string | null;
  answered_via:      string | null;
  dedup_fingerprint: string;
  timeout_ms:        number | null;
  created_at:        string;
  updated_at:        string;
  answered_at:       string | null;
  expires_at:        string | null;
}

export interface FingerprintInput {
  conversationId: string;
  kind?:          AgentQuestionKind;
  questions:      UserQuestion[];
}

export interface RecordQuestionInput {
  id:              string;
  conversationId:  string;
  questions:       UserQuestion[];
  profileId?:      string;
  taskId?:         string | null;
  agent?:          string | null;
  kind?:           AgentQuestionKind;
  title?:          string | null;
  context?:        string | null;
  recommendation?: string | null;
  risk?:           string | null;
  timeoutMs?:      number | null;
  fingerprint?:    string;
}

export interface RecordQuestionResult {
  /**
   * The canonical durable row for this ask. When `created` is false this is
   * the OLDER pending row that deduplicated the ask — callers MUST use
   * `question.id` (not the id they generated) for everything downstream:
   * the emitted card, the parked promise, and timeout bookkeeping. A dedup
   * hit with a divergent id would strand the answer.
   */
  question: AgentQuestionRecord;
  created:  boolean;
}

export interface AnswerQuestionInput {
  answers:      UserQuestionAnswerItem[];
  answeredBy?:  string | null;
  answeredVia?: AgentQuestionChannel;
}

export interface AnswerQuestionResult {
  /** true when THIS call transitioned the row pending -> answered (claimed it). */
  ok:       boolean;
  /**
   * The row as visible within the caller's scope. `null` means no row is
   * visible to this scope — either it never existed or it belongs to a
   * different profile (indistinguishable on purpose).
   */
  question: AgentQuestionRecord | null;
}

export class AgentQuestionModel {
  /**
   * Stable content fingerprint used for dedup. Insensitive to option order,
   * question order, case, and surrounding whitespace so a re-ask of the same
   * decision collapses onto the existing pending row.
   */
  static fingerprint(input: FingerprintInput): string {
    const normalized = {
      conversationId: (input.conversationId ?? '').trim(),
      kind:           input.kind ?? 'decision',
      questions:      [...(input.questions ?? [])]
        .map(q => ({
          question:    (q?.question ?? '').trim().toLowerCase(),
          multiSelect: Boolean(q?.multiSelect),
          options:     [...(q?.options ?? [])]
            .map(o => (o?.label ?? '').trim().toLowerCase())
            .sort((a, b) => a.localeCompare(b)),
        }))
        .sort((a, b) => a.question.localeCompare(b.question)),
    };
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  /**
   * Record a freshly-asked question. Idempotent per live (profile,
   * fingerprint): if a pending question with the same fingerprint already
   * exists in the same profile, that row is returned (created=false) instead
   * of inserting a duplicate prompt.
   *
   * The upsert is a single atomic statement (`ON CONFLICT … DO UPDATE …
   * RETURNING *`), so there is no window between a conflicting insert and a
   * follow-up SELECT in which the older pending row could disappear — the
   * statement always returns exactly one row (the fresh insert or the
   * existing pending row, distinguished via the xmax system column). The
   * DO UPDATE deliberately only touches `updated_at`, which doubles as a
   * "last re-asked" stamp on the surviving row.
   */
  static async record(input: RecordQuestionInput): Promise<RecordQuestionResult> {
    const kind = input.kind ?? 'decision';
    const profileId = input.profileId ?? DEFAULT_PROFILE_ID;
    const fingerprint = input.fingerprint
      ?? AgentQuestionModel.fingerprint({ conversationId: input.conversationId, kind, questions: input.questions });
    const expiresAt = input.timeoutMs && input.timeoutMs > 0
      ? new Date(Date.now() + input.timeoutMs)
      : null;

    return postgresClient.transaction(async(client) => {
      const upserted = await client.query<AgentQuestionRecord & { was_inserted: boolean }>(`
        INSERT INTO agent_questions
          (id, profile_id, conversation_id, task_id, agent, kind, title, context,
           recommendation, risk, questions, status, dedup_fingerprint,
           timeout_ms, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'pending', $12, $13, $14)
        ON CONFLICT (profile_id, dedup_fingerprint) WHERE status = 'pending'
        DO UPDATE SET updated_at = now()
        RETURNING *, (xmax = 0) AS was_inserted
      `, [
        input.id, profileId, input.conversationId, input.taskId ?? null, input.agent ?? null,
        kind, input.title ?? null, input.context ?? null,
        input.recommendation ?? null, input.risk ?? null,
        JSON.stringify(input.questions), fingerprint,
        input.timeoutMs ?? null, expiresAt,
      ]);
      const row = upserted.rows[0];
      if (!row) {
        // DO UPDATE always returns the winning row; reaching this means the
        // driver/schema is broken. Fail loudly rather than hand back a row
        // the caller would park a promise against.
        throw new Error('[AgentQuestionModel] record(): upsert returned no row');
      }
      const { was_inserted: wasInserted, ...question } = row;
      return { question: question as AgentQuestionRecord, created: wasInserted };
    });
  }

  /**
   * Atomically claim a pending question with the user's answers: only a row
   * still in `pending` (and visible to `scope`, when given) transitions to
   * `answered`. Fails closed on a stale / double / out-of-scope submit —
   * `ok:false` and no state change. Callers that resume live promises MUST
   * claim here FIRST and only resume when `ok` is true (claim-then-resolve),
   * so a crash or a concurrent double-answer can never double-resume.
   */
  static async answer(id: string, input: AnswerQuestionInput, scope?: QuestionScope): Promise<AnswerQuestionResult> {
    const profileId = scope?.profileId ?? null;
    return postgresClient.transaction(async(client) => {
      const updated = await client.query<AgentQuestionRecord>(`
        UPDATE agent_questions
           SET status       = 'answered',
               answers      = $2::jsonb,
               answered_by  = $3,
               answered_via = $4,
               answered_at  = now(),
               updated_at   = now()
         WHERE id = $1 AND status = 'pending'
           AND ($5::text IS NULL OR profile_id = $5)
         RETURNING *
      `, [id, JSON.stringify(input.answers), input.answeredBy ?? null, input.answeredVia ?? null, profileId]);
      if (updated.rows[0]) return { ok: true, question: updated.rows[0] };

      // Scope-filtered read-back: an out-of-scope answerer learns nothing
      // beyond "not visible to you".
      const current = await client.query<AgentQuestionRecord>(`
        SELECT * FROM agent_questions
         WHERE id = $1 AND ($2::text IS NULL OR profile_id = $2)
      `, [id, profileId]);
      return { ok: false, question: current.rows[0] ?? null };
    });
  }

  static async getById(id: string, scope?: QuestionScope): Promise<AgentQuestionRecord | null> {
    const profileId = scope?.profileId ?? null;
    return postgresClient.transaction(async(client) => {
      const result = await client.query<AgentQuestionRecord>(`
        SELECT * FROM agent_questions
         WHERE id = $1 AND ($2::text IS NULL OR profile_id = $2)
      `, [id, profileId]);
      return result.rows[0] ?? null;
    });
  }

  /**
   * Pending questions, newest first. Pass a scope for the answerer-facing
   * inbox; omit it only for machine-wide maintenance (restart replay).
   */
  static async listPending(scope?: QuestionScope | null, limit = 50): Promise<AgentQuestionRecord[]> {
    const capped = Math.max(1, Math.min(200, limit));
    const profileId = scope?.profileId ?? null;
    return postgresClient.transaction(async(client) => {
      const result = await client.query<AgentQuestionRecord>(`
        SELECT * FROM agent_questions
         WHERE status = 'pending' AND ($2::text IS NULL OR profile_id = $2)
         ORDER BY created_at DESC
         LIMIT $1
      `, [capped, profileId]);
      return result.rows;
    });
  }

  static async listByConversation(conversationId: string, scope?: QuestionScope | null, limit = 50): Promise<AgentQuestionRecord[]> {
    const capped = Math.max(1, Math.min(200, limit));
    const profileId = scope?.profileId ?? null;
    return postgresClient.transaction(async(client) => {
      const result = await client.query<AgentQuestionRecord>(`
        SELECT * FROM agent_questions
         WHERE conversation_id = $1 AND ($3::text IS NULL OR profile_id = $3)
         ORDER BY created_at DESC
         LIMIT $2
      `, [conversationId, capped, profileId]);
      return result.rows;
    });
  }

  /** Mark a pending question expired (timeout fired with no answer). */
  static async expire(id: string): Promise<boolean> {
    return postgresClient.transaction(async(client) => {
      const result = await client.query(`
        UPDATE agent_questions SET status = 'expired', updated_at = now()
         WHERE id = $1 AND status = 'pending'
      `, [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  /** Supersede any other pending rows sharing a fingerprint within a profile. */
  static async supersedePending(fingerprint: string, exceptId?: string, profileId: string = DEFAULT_PROFILE_ID): Promise<number> {
    return postgresClient.transaction(async(client) => {
      const result = await client.query(`
        UPDATE agent_questions SET status = 'superseded', updated_at = now()
         WHERE dedup_fingerprint = $1 AND profile_id = $3 AND status = 'pending'
           AND ($2::text IS NULL OR id <> $2)
      `, [fingerprint, exceptId ?? null, profileId]);
      return result.rowCount ?? 0;
    });
  }
}
