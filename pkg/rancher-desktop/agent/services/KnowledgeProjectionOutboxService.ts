import { randomUUID } from 'node:crypto';

import { postgresClient } from '../database/PostgresClient';

import type { KnowledgeNodeRecord } from '../database/models/KnowledgeGraphModel';
import type { PoolClient } from 'pg';
const POLL_INTERVAL_MS = 5_000;
const MAX_BATCH_SIZE = 50;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const KNOWLEDGE_PROJECTION_LOCK_NAMESPACE = 1_934_224_241;
const KNOWLEDGE_PROJECTION_LOCK_KEY = 1_263_487_047;

interface ProjectionEventRow {
  id:           string;
  event_type:   'upsert' | 'merge';
  payload:      { node?: KnowledgeNodeRecord; sourceId?: string; targetId?: string };
  attempts:     number;
  available_at: string | Date;
}

/** Serialize canonical mutation commits, reconciliation snapshots, and drain reads. */
export async function acquireKnowledgeProjectionLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [KNOWLEDGE_PROJECTION_LOCK_NAMESPACE, KNOWLEDGE_PROJECTION_LOCK_KEY]);
}

export async function enqueueKnowledgeProjectionUpsert(client: PoolClient, node: KnowledgeNodeRecord): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_projection_outbox(event_type, aggregate_id, payload)
     VALUES ('upsert', $1, jsonb_build_object('node', $2::jsonb))`,
    [node.id, JSON.stringify(node)],
  );
}

export async function enqueueKnowledgeProjectionMerge(client: PoolClient, sourceId: string, targetId: string): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_projection_outbox(event_type, aggregate_id, payload)
     VALUES ('merge', $1, jsonb_build_object('sourceId', $1::text, 'targetId', $2::text))`,
    [sourceId, targetId],
  );
}

let instance: KnowledgeProjectionOutboxService | null = null;

export function getKnowledgeProjectionOutboxService(): KnowledgeProjectionOutboxService {
  instance ??= new KnowledgeProjectionOutboxService();
  return instance;
}

/** Serial, ordered delivery of canonical Knowledge mutations to Projects. */
export class KnowledgeProjectionOutboxService {
  private initialized = false;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.seedReconciliation();
    this.initialized = true;
    this.poll().catch(error => console.error('[KnowledgeProjectionOutbox] Unexpected poll failure', error));
  }

  destroy(): void {
    this.initialized = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async seedReconciliation(): Promise<void> {
    // A projection may have been rebuilt since the previous successful drain.
    // Give every snapshot its own durable generation so its NULL-merged upserts
    // are always followed by the matching terminal merge replays.
    const generation = randomUUID();

    await postgresClient.transaction(async(client) => {
      await acquireKnowledgeProjectionLock(client);
      await client.query(`
        INSERT INTO knowledge_projection_outbox(event_type, aggregate_id, payload, reconciliation_key)
        SELECT 'upsert', n.id,
          jsonb_build_object('node', jsonb_build_object(
            'id', n.id, 'node_type', n.node_type, 'title', n.title,
            'summary', n.summary, 'detail', n.detail, 'link_count', n.link_count,
            'recall_count', n.recall_count, 'last_recalled_at', n.last_recalled_at,
            'archived', n.archived, 'merged_into', NULL, 'source', n.source,
            'created_at', n.created_at, 'updated_at', n.updated_at
          )),
          'knowledge-reconcile:' || $1 || ':upsert:' || n.id
        FROM knowledge_nodes n
        ORDER BY n.created_at, n.id
        ON CONFLICT (reconciliation_key) DO NOTHING
      `, [generation]);
      await client.query(`
        WITH RECURSIVE merge_chain AS (
          SELECT n.id AS source_id, n.merged_into AS target_id,
                 ARRAY[n.id]::text[] AS path, 0 AS depth
          FROM knowledge_nodes n
          WHERE n.merged_into IS NOT NULL
          UNION ALL
          SELECT chain.source_id, target.merged_into,
                 chain.path || target.id, chain.depth + 1
          FROM merge_chain chain
          JOIN knowledge_nodes target ON target.id = chain.target_id
          WHERE target.merged_into IS NOT NULL
            AND chain.depth < 32
            AND NOT target.id = ANY(chain.path)
        ), terminal_targets AS (
          SELECT DISTINCT ON (chain.source_id)
                 chain.source_id, chain.target_id
          FROM merge_chain chain
          JOIN knowledge_nodes target ON target.id = chain.target_id
          WHERE target.merged_into IS NULL
          ORDER BY chain.source_id, chain.depth DESC
        )
        INSERT INTO knowledge_projection_outbox(event_type, aggregate_id, payload, reconciliation_key)
        SELECT 'merge', terminal.source_id,
          jsonb_build_object('sourceId', terminal.source_id, 'targetId', terminal.target_id),
          'knowledge-reconcile:' || $1 || ':merge:' || terminal.source_id || ':' || terminal.target_id
        FROM terminal_targets terminal
        ORDER BY terminal.source_id
        ON CONFLICT (reconciliation_key) DO NOTHING
      `, [generation]);
    });
  }

  private scheduleNext(): void {
    if (!this.initialized) return;
    this.pollTimer = setTimeout(() => {
      this.poll().catch(error => console.error('[KnowledgeProjectionOutbox] Unexpected poll failure', error));
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private async poll(): Promise<void> {
    if (!this.initialized || this.polling) return;
    this.polling = true;
    try {
      for (let processed = 0; processed < MAX_BATCH_SIZE && this.initialized; processed++) {
        if (!await this.deliverOldestEvent()) break;
      }
    } catch (error) {
      console.error('[KnowledgeProjectionOutbox] Poll failed', error);
    } finally {
      this.polling = false;
      this.scheduleNext();
    }
  }

  /** Hold the ordering lock through remote acknowledgement and local completion. */
  private deliverOldestEvent(): Promise<boolean> {
    return postgresClient.transaction(async(client) => {
      await acquireKnowledgeProjectionLock(client);
      if (!this.initialized) return false;
      const { rows } = await client.query<ProjectionEventRow>(
        `SELECT id, event_type, payload, attempts, available_at
         FROM knowledge_projection_outbox
         WHERE completed_at IS NULL
         ORDER BY id ASC
         LIMIT 1`,
      );
      const event = rows[0];
      if (!event) return false;
      const availableAt = event.available_at instanceof Date
        ? event.available_at.getTime()
        : new Date(event.available_at).getTime();
      if (availableAt > Date.now()) return false;

      try {
        const { getProjectsApplicationService } = await import('../projects/application/ProjectsApplicationService');
        const projects = getProjectsApplicationService();
        if (event.event_type === 'upsert') {
          if (!event.payload.node?.id) throw new Error(`Projection event ${ event.id } has no node payload`);
          await projects.upsertKnowledgeProjection(event.payload.node);
        } else {
          if (!event.payload.sourceId || !event.payload.targetId) throw new Error(`Projection event ${ event.id } has no merge payload`);
          await projects.mergeKnowledgeProjection(event.payload.sourceId, event.payload.targetId);
        }
        await client.query(
          `UPDATE knowledge_projection_outbox
           SET completed_at = now(), last_error = NULL
           WHERE id = $1 AND completed_at IS NULL`,
          [event.id],
        );
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const delayMs = Math.min(MAX_RETRY_DELAY_MS, POLL_INTERVAL_MS * 2 ** Math.min(event.attempts, 6));
        await client.query(
          `UPDATE knowledge_projection_outbox
           SET attempts = attempts + 1, available_at = now() + ($2 * interval '1 millisecond'),
               last_error = left($3, 2000)
           WHERE id = $1 AND completed_at IS NULL`,
          [event.id, delayMs, message],
        );
        console.warn(`[KnowledgeProjectionOutbox] Delivery ${ event.id } failed; retrying in ${ delayMs }ms: ${ message }`);
        return false;
      }
    });
  }
}
