// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Production wiring for V7Dreamer: the Postgres v7 store, the Settings-backed
 * cursor and the subconscious model slot. One Dreamer per process, so the
 * single-flight guard covers every caller (the routine's tool-call node, a
 * manual tool call, a schedule catch-up fire).
 */

import { postgresClient } from '../database/PostgresClient';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import {
  DEFAULT_DREAMER_INTERVAL_MINUTES,
  DREAMER_WORKER,
  V7Dreamer,
  type DreamBatch,
  type DreamContext,
  type DreamCursorStore,
  type DreamEpisode,
  type DreamItem,
  type DreamModel,
  type DreamWindow,
  type V7DreamStore,
  type ValidatedDreamWrite,
} from './V7Dreamer';

export const DREAMER_INTERVAL_SETTING = 'dreamerIntervalMinutes';
export const DREAMER_CURSOR_SETTING = 'dreamerLastWindowEndMs';
const MAX_CONTEXT_ITEMS = 150;

export class PostgresV7DreamStore implements V7DreamStore {
  async loadWindow(window: DreamWindow, limits: { episodes: number; items: number }): Promise<DreamBatch> {
    // Newest rows win when a window overflows the limits; returned oldest first.
    const [episodes, items] = await Promise.all([
      postgresClient.query<DreamEpisode>(
        `SELECT id, ts, source, text, keys, sentiment FROM (
           SELECT id, ts, source, text, keys, sentiment FROM subject_memory.episodes
            WHERE ts >= $1 AND ts < $2 AND coalesce(worker, '') <> $3
            ORDER BY ts DESC LIMIT $4) recent
          ORDER BY ts ASC, id ASC`,
        [window.fromTs, window.toTs, DREAMER_WORKER, limits.episodes],
      ),
      postgresClient.query<DreamItem>(
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
      postgresClient.query<{ slug: string; name: string; kind: string }>(
        'SELECT slug, name, kind FROM subject_memory.subjects ORDER BY slug',
      ),
      postgresClient.query<DreamItem>(
        `SELECT id, kind, ptype, text, why, scope, origin, ts, supersedes
           FROM subject_memory.current_items()
          WHERE scope && $1::text[] AND origin <> 'seeded'
          ORDER BY ts DESC
          LIMIT $2`,
        [subjectSlugs, MAX_CONTEXT_ITEMS],
      ),
    ]);

    return {
      subjects,
      currentItems: currentItems.map(row => ({ ...row, ts: Number(row.ts), scope: row.scope ?? [] })),
    };
  }

  async appendDream(write: ValidatedDreamWrite): Promise<{ items: number; evidence: number }> {
    return postgresClient.transaction(async(client) => {
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

export class SettingsDreamCursor implements DreamCursorStore {
  async getLastWindowEnd(): Promise<number | null> {
    const value = Number(await SullaSettingsModel.get(DREAMER_CURSOR_SETTING, null));

    return Number.isFinite(value) && value > 0 ? value : null;
  }

  async setLastWindowEnd(ms: number): Promise<void> {
    await SullaSettingsModel.set(DREAMER_CURSOR_SETTING, ms, 'number');
  }

  async getIntervalMinutes(): Promise<number> {
    return Number(await SullaSettingsModel.get(DREAMER_INTERVAL_SETTING, DEFAULT_DREAMER_INTERVAL_MINUTES));
  }
}

/** One subconscious-slot model call, bounded by the process-wide writer gate. */
export class SubconsciousDreamModel implements DreamModel {
  async dream(systemPrompt: string, userMessage: string): Promise<string | null> {
    const [{ GraphRegistry }, { runThroughWriterGate }] = await Promise.all([
      import('../services/GraphRegistry'),
      import('../services/SubconsciousWriterGate'),
    ]);

    return runThroughWriterGate(async() => {
      const created = await GraphRegistry.createV7Dreamer(systemPrompt, userMessage);
      // maxIterations 1: one node pass, so exactly one model call per batch.
      await created.graph.execute(created.state, 'subconscious', { maxIterations: 1 });
      const output = (created.state.metadata as any).v7DreamerOutput;

      return typeof output === 'string' ? output : null;
    });
  }
}

let dreamer: V7Dreamer | null = null;

export function getV7Dreamer(): V7Dreamer {
  if (!dreamer) {
    dreamer = new V7Dreamer({
      store:  new PostgresV7DreamStore(),
      cursor: new SettingsDreamCursor(),
      model:  new SubconsciousDreamModel(),
    });
  }

  return dreamer;
}
