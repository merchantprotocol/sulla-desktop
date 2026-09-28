/**
 * ReflexModel — training examples and decision receipts for the Reflex
 * decision engine (see agent/reflex/). Tables are created by migration 0099.
 *
 * Examples are never hard-deleted; `forget` soft-archives so training history
 * stays recoverable and exportable.
 */

import { postgresClient } from '../PostgresClient';

import type { ReflexExample } from '../../reflex/ReflexEngine';

export interface ReflexExampleRow {
  id:         string;
  utterance:  string;
  tool_name:  string;
  params:     Record<string, unknown>;
  positive:   boolean;
  source:     string;
  thread_id:  string | null;
  archived:   boolean;
  created_at: string;
  updated_at: string;
}

export interface ReflexDecisionRow {
  id:         string;
  thread_id:  string | null;
  utterance:  string;
  tool_name:  string;
  params:     Record<string, unknown>;
  confidence: number;
  status:     ReflexDecisionStatus;
  result:     string | null;
  corrected:  boolean;
  created_at: string;
}

/** acted = executed; failed = executed with an error; below_threshold / blocked = not executed */
export type ReflexDecisionStatus = 'acted' | 'failed' | 'below_threshold' | 'blocked';

export interface TeachInput {
  utterance: string;
  toolName:  string;
  params?:   Record<string, unknown>;
  positive?: boolean;
  source?:   string;
  threadId?: string | null;
}

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

/** Bumped on every example write so ReflexService knows to retrain. */
let examplesVersion = 0;

export class ReflexModel {
  static get version(): number {
    return examplesVersion;
  }

  /** Insert an example, or refresh the identical active one. Returns the row and whether it was new. */
  static async teach(input: TeachInput): Promise<{ row: ReflexExampleRow; created: boolean }> {
    const rows = await postgresClient.query<ReflexExampleRow & { inserted: boolean }>(
      `INSERT INTO reflex_examples (id, utterance, tool_name, params, positive, source, thread_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (lower(utterance), tool_name, md5(params::text), positive) WHERE NOT archived
       DO UPDATE SET updated_at = NOW()
       RETURNING *, (xmax = 0) AS inserted`,
      [
        generateId(),
        input.utterance.trim(),
        input.toolName,
        JSON.stringify(input.params ?? {}),
        input.positive !== false,
        input.source || 'model',
        input.threadId ?? null,
      ],
    );
    examplesVersion++;
    const { inserted, ...row } = rows[0];
    return { row, created: inserted };
  }

  static async forget(id: string): Promise<boolean> {
    const result = await postgresClient.queryWithResult(
      'UPDATE reflex_examples SET archived = TRUE, updated_at = NOW() WHERE id = $1 AND NOT archived',
      [id],
    );
    if (result.rowCount) examplesVersion++;
    return (result.rowCount ?? 0) > 0;
  }

  static async activeExamples(): Promise<ReflexExample[]> {
    const rows = await postgresClient.query<ReflexExampleRow>(
      'SELECT id, utterance, tool_name, params, positive FROM reflex_examples WHERE NOT archived',
    );
    return rows.map(r => ({ id: r.id, utterance: r.utterance, toolName: r.tool_name, params: r.params ?? {}, positive: r.positive }));
  }

  static async listExamples(opts: { query?: string; toolName?: string; limit?: number; includeArchived?: boolean } = {}): Promise<ReflexExampleRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeArchived) where.push('NOT archived');
    if (opts.toolName) {
      params.push(opts.toolName);
      where.push(`tool_name = $${ params.length }`);
    }
    if (opts.query) {
      params.push(`%${ opts.query }%`);
      where.push(`utterance ILIKE $${ params.length }`);
    }
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 10_000));
    return postgresClient.query<ReflexExampleRow>(
      `SELECT * FROM reflex_examples ${ where.length ? `WHERE ${ where.join(' AND ') }` : '' }
       ORDER BY updated_at DESC LIMIT $${ params.length }`,
      params,
    );
  }

  static async recordDecision(input: Omit<ReflexDecisionRow, 'id' | 'created_at' | 'corrected'>): Promise<string> {
    const id = generateId();
    await postgresClient.query(
      `INSERT INTO reflex_decisions (id, thread_id, utterance, tool_name, params, confidence, status, result)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [id, input.thread_id, input.utterance, input.tool_name, JSON.stringify(input.params ?? {}), input.confidence, input.status, input.result],
    );
    return id;
  }

  static async getDecision(id: string): Promise<ReflexDecisionRow | null> {
    const rows = await postgresClient.query<ReflexDecisionRow>('SELECT * FROM reflex_decisions WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  static async markCorrected(id: string): Promise<void> {
    await postgresClient.query('UPDATE reflex_decisions SET corrected = TRUE WHERE id = $1', [id]);
  }

  static async recentDecisions(limit = 20): Promise<ReflexDecisionRow[]> {
    return postgresClient.query<ReflexDecisionRow>(
      'SELECT * FROM reflex_decisions ORDER BY created_at DESC LIMIT $1',
      [Math.min(Math.max(limit, 1), 200)],
    );
  }

  static async stats(): Promise<{ examples: number; negatives: number; tools: number; decisions: Record<string, number>; corrected: number }> {
    const [ex] = await postgresClient.query<{ examples: string; negatives: string; tools: string }>(
      `SELECT COUNT(*) AS examples, COUNT(*) FILTER (WHERE NOT positive) AS negatives,
              COUNT(DISTINCT tool_name) AS tools
         FROM reflex_examples WHERE NOT archived`,
    );
    const dec = await postgresClient.query<{ status: string; n: string }>(
      'SELECT status, COUNT(*) AS n FROM reflex_decisions GROUP BY status',
    );
    const [corr] = await postgresClient.query<{ n: string }>('SELECT COUNT(*) AS n FROM reflex_decisions WHERE corrected');
    return {
      examples:  Number(ex?.examples ?? 0),
      negatives: Number(ex?.negatives ?? 0),
      tools:     Number(ex?.tools ?? 0),
      decisions: Object.fromEntries(dec.map(d => [d.status, Number(d.n)])),
      corrected: Number(corr?.n ?? 0),
    };
  }
}
