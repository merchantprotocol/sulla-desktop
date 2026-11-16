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

/** v7 subject-memory reads and the atomic dream append for V7Dreamer. */
export class V7DreamRepository implements V7DreamStore {
  static readonly MAX_CONTEXT_ITEMS = 150;

  constructor(private readonly client: Pick<typeof postgresClient, 'query' | 'transaction'> = postgresClient) {}

  async loadWindow(window: DreamWindow, limits: { episodes: number; items: number }): Promise<DreamBatch> {
    // Newest rows win when a window overflows the limits; returned oldest first.
    const [episodes, items] = await Promise.all([
      this.client.query<DreamEpisode>(
        `SELECT id, ts, source, text, keys, sentiment FROM (
           SELECT id, ts, source, text, keys, sentiment FROM subject_memory.episodes
            WHERE ts >= $1 AND ts < $2 AND coalesce(worker, '') <> $3
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
