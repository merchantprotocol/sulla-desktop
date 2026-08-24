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
 */
export type AgentQuestionKind = 'decision' | 'dependency' | 'test';
export type AgentQuestionStatus = 'pending' | 'answered' | 'expired' | 'superseded' | 'cancelled';
export type AgentQuestionChannel = 'desktop' | 'mobile';

export interface AgentQuestionRecord {
  id:                string;
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
  question: AgentQuestionRecord;
  created:  boolean;
}

export interface AnswerQuestionInput {
  answers:      UserQuestionAnswerItem[];
  answeredBy?:  string | null;
  answeredVia?: AgentQuestionChannel;
}

export interface AnswerQuestionResult {
  ok:       boolean;
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
   * Record a freshly-asked question. Idempotent per live fingerprint: if a
   * pending question with the same fingerprint already exists, that row is
   * returned (created=false) instead of inserting a duplicate prompt.
   */
  static async record(input: RecordQuestionInput): Promise<RecordQuestionResult> {
    const kind = input.kind ?? 'decision';
    const fingerprint = input.fingerprint
      ?? AgentQuestionModel.fingerprint({ conversationId: input.conversationId, kind, questions: input.questions });
    const expiresAt = input.timeoutMs && input.timeoutMs > 0
      ? new Date(Date.now() + input.timeoutMs)
      : null;

    return postgresClient.transaction(async(client) => {
      const inserted = await client.query<AgentQuestionRecord>(`
        INSERT INTO agent_questions
          (id, conversation_id, task_id, agent, kind, title, context,
           recommendation, risk, questions, status, dedup_fingerprint,
           timeout_ms, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending', $11, $12, $13)
        ON CONFLICT (dedup_fingerprint) WHERE status = 'pending'
        DO NOTHING
        RETURNING *
      `, [
        input.id, input.conversationId, input.taskId ?? null, input.agent ?? null,
        kind, input.title ?? null, input.context ?? null,
        input.recommendation ?? null, input.risk ?? null,
        JSON.stringify(input.questions), fingerprint,
        input.timeoutMs ?? null, expiresAt,
      ]);
      if (inserted.rows[0]) return { question: inserted.rows[0], created: true };

      const existing = await client.query<AgentQuestionRecord>(`
        SELECT * FROM agent_questions
         WHERE dedup_fingerprint = $1 AND status = 'pending'
         ORDER BY created_at DESC
         LIMIT 1
      `, [fingerprint]);
      return { question: existing.rows[0], created: false };
    });
  }

  /** Answer a pending question. Fails closed on a stale / double submit:
   *  only a row still in `pending` transitions to `answered`. */
  static async answer(id: string, input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
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
         RETURNING *
      `, [id, JSON.stringify(input.answers), input.answeredBy ?? null, input.answeredVia ?? null]);
      if (updated.rows[0]) return { ok: true, question: updated.rows[0] };

      const current = await client.query<AgentQuestionRecord>(
        'SELECT * FROM agent_questions WHERE id = $1', [id],
      );
      return { ok: false, question: current.rows[0] ?? null };
    });
  }

  static async getById(id: string): Promise<AgentQuestionRecord | null> {
    return postgresClient.transaction(async(client) => {
      const result = await client.query<AgentQuestionRecord>(
        'SELECT * FROM agent_questions WHERE id = $1', [id],
      );
      return result.rows[0] ?? null;
    });
  }

  static async listPending(limit = 50): Promise<AgentQuestionRecord[]> {
    const capped = Math.max(1, Math.min(200, limit));
    return postgresClient.transaction(async(client) => {
      const result = await client.query<AgentQuestionRecord>(`
        SELECT * FROM agent_questions
         WHERE status = 'pending'
         ORDER BY created_at DESC
         LIMIT $1
      `, [capped]);
      return result.rows;
    });
  }

  static async listByConversation(conversationId: string, limit = 50): Promise<AgentQuestionRecord[]> {
    const capped = Math.max(1, Math.min(200, limit));
    return postgresClient.transaction(async(client) => {
      const result = await client.query<AgentQuestionRecord>(`
        SELECT * FROM agent_questions
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2
      `, [conversationId, capped]);
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

  /** Supersede any other pending rows sharing a fingerprint. */
  static async supersedePending(fingerprint: string, exceptId?: string): Promise<number> {
    return postgresClient.transaction(async(client) => {
      const result = await client.query(`
        UPDATE agent_questions SET status = 'superseded', updated_at = now()
         WHERE dedup_fingerprint = $1 AND status = 'pending'
           AND ($2::text IS NULL OR id <> $2)
      `, [fingerprint, exceptId ?? null]);
      return result.rowCount ?? 0;
    });
  }
}
