/**
 * MemoryRecallService — DB-backed wrapper around RankedRecallIndex.
 *
 * Loads every active memory from `observations` and all `identity_observations`
 * domains into one in-memory index (embeddings are computed in-process with the
 * bundled potion model — no embedding column, no pgvector). The index is
 * rebuilt only when the tables change, detected with a cheap count/max-timestamp
 * signature per recall, so a typical turn costs one tiny query plus the ranking.
 *
 * Returns null whenever ranked recall can't run (model not bundled, DB error) so
 * the caller falls back to the per-domain SQL recall instead of losing context.
 */

import { PotionEmbedder } from './potionEmbedder';
import { MemoryRow, RankedRecallIndex } from './rankedRecall';
import { postgresClient } from '../database/PostgresClient';
import { formatDateOnly } from '../utils/formatDateOnly';
import { resolveBundledModelDir } from '../utils/sullaPaths';

export const POTION_MODEL_NAME = 'potion-retrieval-32M';
export const OBSERVATION_DOMAIN = 'observation';

export interface RecalledMemory extends MemoryRow {
  score:    number;
  /** identity category, or the observation priority. */
  category: string | null;
  basis:    string | null;
}

interface SourceRow {
  id:       string;
  domain:   string;
  level:    number | null;
  content:  string;
  category: string | null;
  basis:    string | null;
  recorded: string | Date | null;
}

let embedder: PotionEmbedder | null | undefined;

interface IndexState {
  signature: string;
  index:     RankedRecallIndex;
  meta:      Map<string, SourceRow>;
}

let cached: IndexState | null = null;
let building: Promise<IndexState | null> | null = null;

function getEmbedder(): PotionEmbedder | null {
  if (embedder !== undefined) return embedder;
  const dir = resolveBundledModelDir(POTION_MODEL_NAME);

  try {
    embedder = dir ? PotionEmbedder.load(dir) : null;
  } catch (error) {
    console.error('[MemoryRecall] Failed to load potion model:', error instanceof Error ? error.message : error);
    embedder = null;
  }
  if (!embedder) console.warn(`[MemoryRecall] Bundled model ${ POTION_MODEL_NAME } not found — ranked recall disabled, using SQL recall`);

  return embedder;
}

async function signature(): Promise<string> {
  const rows = await postgresClient.query<{ sig: string }>(`
    SELECT concat_ws('|',
      (SELECT count(*) FROM identity_observations WHERE archived = false),
      (SELECT max(coalesce(updated_at, created_at)) FROM identity_observations),
      (SELECT count(*) FROM observations WHERE archived = false),
      (SELECT max(coalesce(updated_at, created_at)) FROM observations)
    ) AS sig`);

  return rows[0]?.sig ?? '';
}

async function loadRows(): Promise<SourceRow[]> {
  const identity = await postgresClient.query<SourceRow>(`
    SELECT id, domain, level, content, category, basis, coalesce(created_at, updated_at) AS recorded
      FROM identity_observations WHERE archived = false`);
  const observations = await postgresClient.query<SourceRow>(`
    SELECT id, '${ OBSERVATION_DOMAIN }' AS domain, NULL::int AS level, content, priority AS category, NULL AS basis,
           coalesce(created_at, updated_at) AS recorded
      FROM observations WHERE archived = false`);

  return [...identity, ...observations].filter(r => typeof r.content === 'string' && r.content.trim());
}

async function getIndex(model: PotionEmbedder): Promise<IndexState | null> {
  const sig = await signature();

  if (cached?.signature === sig) return cached;
  if (building) return building;
  building = (async() => {
    const t0 = Date.now();
    const source = await loadRows();
    const rows: MemoryRow[] = source.map(r => ({
      id: r.id, domain: r.domain, level: r.level ?? null, date: formatDateOnly(r.recorded), content: r.content,
    }));
    const index = new RankedRecallIndex(rows, model);

    cached = { signature: sig, index, meta: new Map(source.map(r => [r.id, r])) };
    console.log(`[MemoryRecall] Indexed ${ rows.length } memories in ${ Date.now() - t0 }ms`);

    return cached;
  })();
  try {
    return await building;
  } finally {
    building = null;
  }
}

/**
 * Rank all memories for this turn: the top 16 of every memory domain.
 * @param context latest user message first, then up to 2 earlier user messages.
 * @returns ranked memories (always dated), or null when ranked recall is unavailable.
 */
export async function recallRankedMemories(context: string[], now = new Date()): Promise<RecalledMemory[] | null> {
  const model = getEmbedder();

  if (!model) return null;
  try {
    const state = await getIndex(model);

    if (!state) return null;
    const today = now.toISOString().slice(0, 10);

    return state.index.searchPerDomain(context, today).map(({ row, score }) => {
      const src = state.meta.get(row.id);

      return { ...row, score, category: src?.category ?? null, basis: src?.basis ?? null };
    });
  } catch (error) {
    console.error('[MemoryRecall] Ranked recall failed:', error instanceof Error ? error.message : error);

    return null;
  }
}

/** Test hook: drop cached model/index. */
export function resetMemoryRecallCache(): void {
  embedder = undefined;
  cached = null;
  building = null;
}
