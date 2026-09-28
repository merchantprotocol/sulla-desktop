import { randomUUID } from 'crypto';

import { postgresClient } from '../database/PostgresClient';

import type { DecisionOutcome, DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';

/** Durable inbox; execution stays parked in the ORIGINAL caller, never a new graph.
 * Restarted processes cannot safely replay closures: their rows expire, fail closed.
 * No tool arguments or credentials are copied into cloud snapshots.
 */
export class DecisionService {
  private readonly session = randomUUID();
  private readonly listeners = new Set<(record: DecisionRecord) => void>();
  subscribe(listener: (record: DecisionRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(record: DecisionRecord): void { for (const listener of this.listeners) { try { listener(record) } catch { /* persistence remains authoritative */ } } }
  private readonly waiting = new Map<string, {
    record:  DecisionRecord;
    settle:  (outcome: DecisionOutcome) => void;
    timer:   ReturnType<typeof setTimeout>;
    busy:    boolean;
    cleanup: () => void;
  }>();

  async request(input: Omit<DecisionRecord, 'id' | 'status' | 'createdAt' | 'expiresAt'>, timeoutMs = 30 * 60_000, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Request cancelled');
    if (!input.conversationId || !input.channel) throw new Error('Approval requires the original conversation. No action was executed.');
    const now = Date.now();
    const record: DecisionRecord = { ...input, id: randomUUID(), status: 'pending', createdAt: now, expiresAt: now + timeoutMs };
    await postgresClient.query('INSERT INTO human_decisions (id, session_id, status, record) VALUES ($1, $2, $3, $4::jsonb)',
      [record.id, this.session, record.status, JSON.stringify(record)]);
    let settle!: (value: DecisionOutcome) => void;
    const result = new Promise<DecisionOutcome>(resolve => { settle = resolve });
    const timer = setTimeout(() => { this.expire(record.id) }, timeoutMs);
    timer.unref?.();
    const abort = () => { this.expire(record.id) };
    this.waiting.set(record.id, { record, settle, timer, busy: false, cleanup: () => signal?.removeEventListener('abort', abort) });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else this.changed(record);
    return { record, result };
  }

  async list(): Promise<DecisionRecord[]> {
    // Rows from a previous process are evidence, never runnable requests.
    await postgresClient.query(`UPDATE human_decisions SET status = 'expired',
      record = jsonb_set(record, '{status}', '"expired"'), updated_at = NOW()
      WHERE status IN ('pending', 'deferred') AND (session_id <> $1 OR (record->>'expiresAt')::bigint <= $2)`, [this.session, Date.now()]);
    const rows = await postgresClient.query<{ record: DecisionRecord }>(
      "SELECT record FROM human_decisions ORDER BY (status IN ('pending', 'deferred')) DESC, updated_at DESC LIMIT 500");
    return rows.map(row => row.record);
  }

  async resolve(response: DecisionResponse): Promise<{ settled: boolean; conversationId?: string; reason?: string }> {
    if (!response || typeof response.id !== 'string' || typeof response.conversationId !== 'string') return { settled: false, reason: 'Request and conversation are required.' };
    const entry = this.waiting.get(response.id);
    if (!entry) return { settled: false, reason: 'Request is no longer waiting.' };
    if (entry.record.conversationId !== response.conversationId || entry.busy) {
      return { settled: false, reason: 'Already answered, unavailable, or not this conversation.' };
    }
    if (Date.now() >= entry.record.expiresAt) {
      await this.expire(response.id);
      return { settled: false, reason: 'This request expired. Ask for a fresh request in the original conversation.' };
    }
    const action = response.action;
    if (!['approved', 'denied', 'answered', 'deferred'].includes(action)) throw new Error('Invalid decision');
    if (entry.record.kind === 'question' && !['answered', 'deferred'].includes(action)) throw new Error('Answer the questions');
    if (entry.record.kind === 'approval' && action === 'answered') throw new Error('Choose approve or deny');
    let answers: DecisionOutcome['answers'] = [];
    if (action === 'answered') {
      const questions = entry.record.questions ?? [];
      if (!Array.isArray(response.answers) || response.answers.length !== questions.length) throw new Error('Answer every question');
      answers = questions.map((q, i) => {
        const selected = response.answers![i]?.selected;
        if (!Array.isArray(selected) || !selected.length || (!q.multiSelect && selected.length !== 1) ||
          selected.some(s => typeof s !== 'string' || !s.trim() || s.length > 10000)) throw new Error('Invalid answer');
        return { question: q.question, selected: selected.map(s => s.trim()) };
      });
    }
    entry.busy = true;
    try {
      const next = { ...entry.record, status: action };
      const rows = await postgresClient.query(`UPDATE human_decisions SET status = $2, record = $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'deferred') AND session_id = $4 RETURNING id`,
      [response.id, action, JSON.stringify(next), this.session]);
      if (!rows.length) return { settled: false, reason: 'Request is no longer pending.' };
      entry.record = next;
      this.changed(next);
      if (action !== 'deferred') {
        entry.cleanup();
        clearTimeout(entry.timer);
        this.waiting.delete(response.id);
        entry.settle({ status: action, answers });
      }
      return { settled: true, conversationId: next.conversationId };
    } finally { entry.busy = false }
  }

  async expire(id: string): Promise<void> {
    const entry = this.waiting.get(id);
    if (!entry) return;
    if (entry.busy) {
      entry.timer = setTimeout(() => { this.expire(id) }, 100);
      entry.timer.unref?.();
      return;
    }
    this.waiting.delete(id);
    clearTimeout(entry.timer);
    entry.cleanup();
    entry.settle({ status: 'expired', answers: [] });
    this.changed({ ...entry.record, status: 'expired' });
    try {
      await postgresClient.query(`UPDATE human_decisions SET status = 'expired', record = jsonb_set(record, '{status}', '"expired"'), updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'deferred')`, [id]);
    } catch { /* Fail closed even if persistence is temporarily unavailable. list() reconciles below. */ }
  }

  async requiresApproval(toolName: string): Promise<boolean> {
    const rows = await postgresClient.query('SELECT tool_name FROM tool_approval_policies WHERE tool_name = $1', [toolName]);
    return rows.length > 0;
  }

  async policies(): Promise<string[]> {
    const rows = await postgresClient.query<{ tool_name: string }>('SELECT tool_name FROM tool_approval_policies ORDER BY tool_name');
    return rows.map(row => row.tool_name);
  }

  async setPolicy(toolName: string, required: boolean): Promise<void> {
    if (required) await postgresClient.query('INSERT INTO tool_approval_policies (tool_name) VALUES ($1) ON CONFLICT DO NOTHING', [toolName]);
    else await postgresClient.query('DELETE FROM tool_approval_policies WHERE tool_name = $1', [toolName]);
  }
}
export const decisionService = new DecisionService();
