import { recallRankedMemories } from '../../memory/MemoryRecallService';

/**
 * Rank one memory domain with the ranked recall engine, then load the full
 * rows so search tools keep their existing output. Returns null when the
 * engine is unavailable so callers fall back to their ILIKE search.
 */
export async function rankedDomainSearch<T>(
  query: string,
  domain: string,
  limit: number,
  load: (id: string) => Promise<T | null>,
): Promise<{ row: T; score: number }[] | null> {
  const hits = await recallRankedMemories([query], new Date(), { domain, limit });

  if (!hits) return null;
  const rows = await Promise.all(hits.map(h => load(h.id)));

  return hits.flatMap((h, i) => (rows[i] ? [{ row: rows[i] as T, score: h.score }] : []));
}
