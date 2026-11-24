// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { postgresClient } from '../../database/PostgresClient';
import {
  DREAMER_WORKER,
  type DreamBatch,
  type DreamContext,
  type DreamEpisode,
  type DreamItem,
  type DreamWindow,
  type V7DreamStore,
  type ValidatedDreamWrite,
} from '../../memory/V7Dreamer';
import type {
  DuplicateSweepStore,
  SweepCursorValue,
  SweepEpisode,
  SweepSubject,
} from '../../memory/V7DuplicateSweeper';

type SweepEpisodeRow = Omit<SweepEpisode, 'ts'> & { ts: number | string };

/** v7 subject-memory reads and the atomic dream append for V7Dreamer. */
export class V7DreamRepository implements V7DreamStore, DuplicateSweepStore {
  static readonly MAX_CONTEXT_ITEMS = 150;

  constructor(private readonly client: Pick<typeof postgresClient, 'query' | 'transaction'> = postgresClient) {}

  async loadWindow(window: DreamWindow, limits: { episodes: number; items: number }): Promise<DreamBatch> {
    // Newest rows win when a window overflows the limits; returned oldest first.
    const [episodes, items] = await Promise.all([
      this.client.query<DreamEpisode>(
        `SELECT id, ts, source, text, keys, sentiment FROM (
           SELECT id, ts, source, text, keys, sentiment FROM subject_memory.episodes
            WHERE ts >= $1 AND ts < $2 AND coalesce(worker, '') <> $3 AND superseded_by IS NULL
            ORDER BY ts DESC LIMIT $4) recent
          ORDER BY ts ASC, id ASC`,
        [window.fromTs, window.toTs, DREAMER_WORKER, limits.episodes],
      ),
      this.client.query<DreamItem>(
        `SELECT id, kind, ptype, text, why, scope, origin, ts, supersedes FROM (
           SELECT id, kind, ptype, text, why, scope, origin, ts, supersedes FROM subject_memory.items
            WHERE ts >= $1 AND ts < $2 AND coalesce(worker, '') <> $3
            ORDER BY ts DESC LIMIT $4) recent
          ORDER BY ts ASC, id ASC`,
        [window.fromTs, window.toTs, DREAMER_WORKER, limits.items],
      ),
    ]);

    return {
      episodes: episodes.map(row => ({ ...row, ts: Number(row.ts), keys: row.keys ?? [] })),
      items:    items.map(row => ({ ...row, ts: Number(row.ts), scope: row.scope ?? [] })),
    };
  }

  async loadSweepEpisodes(limit: number, before?: SweepCursorValue): Promise<SweepEpisode[]> {
    const beforeTs = before === undefined ? null : typeof before === 'number' ? before : before.ts;
    const beforeId = before !== undefined && typeof before !== 'number' ? before.id : null;
    const rows = await this.client.query<SweepEpisodeRow>(
      `SELECT e.id, e.ts, e.conversation_id, e.source, e.sentiment, e.text, e.keys,
              e.checkin_key, e.superseded_by,
              EXISTS (SELECT 1 FROM subject_memory.evidence evidence WHERE evidence.episode_id = e.id) AS "hasEvidence"
         FROM subject_memory.episodes e
        WHERE e.superseded_by IS NULL
          AND ($2::bigint IS NULL
            OR ($3::text IS NULL AND e.ts < $2::bigint)
            OR (e.ts, e.id) < ($2::bigint, $3::text))
        ORDER BY e.ts DESC, e.id DESC
        LIMIT $1`,
      [limit, beforeTs, beforeId],
    );

    return rows.map(row => ({
      ...row,
      ts: Number(row.ts),
      conversation_id: row.conversation_id ?? null,
      keys: row.keys ?? [],
      checkin_key: row.checkin_key ?? null,
      superseded_by: row.superseded_by ?? null,
      hasEvidence: Boolean(row.hasEvidence),
    }));
  }

  async loadSubjects(): Promise<SweepSubject[]> {
    return this.client.query<SweepSubject>(
      'SELECT slug, parent, kind FROM subject_memory.subjects ORDER BY slug',
    );
  }

  async supersedeEpisode(oldId: string, keepId: string, runId: string, nowTs: number): Promise<boolean> {
    const result = await this.client.transaction(client => client.query(
      `UPDATE subject_memory.episodes
          SET superseded_by = $2,
              superseded_ts = $4,
              superseded_reason = 'dream-sweep:' || $3
        WHERE id = $1
          AND id <> $2
          AND superseded_by IS NULL
          AND source <> 'user'
          AND NOT EXISTS (SELECT 1 FROM subject_memory.evidence WHERE episode_id = $1)
          AND EXISTS (SELECT 1 FROM subject_memory.episodes keep WHERE keep.id = $2 AND keep.superseded_by IS NULL)`,
      [oldId, keepId, runId, nowTs],
    ));

    // Undo one sweep without deleting history: UPDATE subject_memory.episodes SET superseded_by=NULL, superseded_ts=NULL, superseded_reason=NULL WHERE superseded_reason='dream-sweep:<runId>'.
    return result.rowCount === 1;
  }

  async loadContext(subjectSlugs: string[]): Promise<DreamContext> {
    const [subjects, currentItems] = await Promise.all([
      this.client.query<{ slug: string; name: string; kind: string }>(
        'SELECT slug, name, kind FROM subject_memory.subjects ORDER BY slug',
      ),
      this.client.query<DreamItem>(
        `SELECT id, kind, ptype, text, why, scope, origin, ts, supersedes
           FROM subject_memory.current_items()
          WHERE scope && $1::text[] AND origin <> 'seeded'
          ORDER BY ts DESC
          LIMIT $2`,
        [subjectSlugs, V7DreamRepository.MAX_CONTEXT_ITEMS],
      ),
    ]);

    return {
      subjects,
      currentItems: currentItems.map(row => ({ ...row, ts: Number(row.ts), scope: row.scope ?? [] })),
    };
  }

  async appendDream(write: ValidatedDreamWrite): Promise<{ items: number; evidence: number }> {
    return this.client.transaction(async(client) => {
      const inserted = { items: 0, evidence: 0 };
      for (const row of write.items) {
        // Plain INSERT: an id collision must abort the whole dream, not half-write it.
        const result = await client.query(
          `INSERT INTO subject_memory.items
             (id, kind, ptype, text, why, scope, origin, ts, supersedes, always_on, worker)
           VALUES ($1, 'conclusion', $2, $3, $4, $5, 'model_inferred', $6, $7, false, $8)`,
          [row.id, row.ptype, row.text, row.why, row.scope, row.ts, row.supersedes, DREAMER_WORKER],
        );
        inserted.items += result.rowCount ?? 0;
      }
      for (const row of write.evidence) {
        const result = await client.query(
          `INSERT INTO subject_memory.evidence (item_id, episode_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (item_id, episode_id) DO NOTHING`,
          [row.item_id, row.episode_id, row.role],
        );
        inserted.evidence += result.rowCount ?? 0;
      }

      return inserted;
    });
  }
}
