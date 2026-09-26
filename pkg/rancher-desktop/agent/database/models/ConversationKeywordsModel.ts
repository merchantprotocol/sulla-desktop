import { postgresClient } from '../PostgresClient';
import { escapeLikeTerm } from '../../utils/recallTerms';

export type ConversationKeywordSource = 'primary' | 'subconscious' | 'worker';

export interface ConversationKeywordRecord {
  id: string;
  term: string;
  thread_id: string;
  conversation_history_id: string | null;
  channel_id: string | null;
  agent_id: string | null;
  source: ConversationKeywordSource;
  first_seen: string | Date;
  last_seen: string | Date;
  hit_count: number;
}

export interface UpsertConversationKeywordsInput {
  terms: string[];
  thread_id: string;
  conversation_history_id?: string | null;
  channel_id?: string | null;
  agent_id?: string | null;
  source?: ConversationKeywordSource;
}

export interface ConversationThreadRecallHit {
  thread_id:     string;
  title:         string | null;
  summary:       string | null;
  last_seen:     string | Date;
  matched_terms: string[];
  score:         number;
}

export type ConversationKeywordMatchReason = 'exact' | 'fuzzy' | 'title_summary_fallback';

export interface ConversationSearchHit {
  thread_id:                string;
  conversation_history_id:  string | null;
  channel_id:               string | null;
  agent_id:                 string | null;
  title:                    string | null;
  summary:                  string | null;
  log_file:                 string | null;
  first_seen:               string | Date | null;
  last_seen:                string | Date | null;
  match_reason:             ConversationKeywordMatchReason;
  matched_term:             string | null;
}

/** Canonical form used by the UNIQUE(term, thread_id) index. */
export function normalizeConversationKeyword(term: string): string {
  return term.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function makeId(): string {
  return `ck_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 12) }`;
}

export class ConversationKeywordsModel {
  private static readonly TABLE = 'conversation_keywords';

  /** Atomically insert each canonical term, or bump its hit count on repeat. */
  static async upsertMany(input: UpsertConversationKeywordsInput): Promise<ConversationKeywordRecord[]> {
    const threadId = input.thread_id?.trim();
    if (!threadId) throw new Error('thread_id is required');

    const terms = Array.from(new Set(
      (input.terms || [])
        .filter((term): term is string => typeof term === 'string')
        .map(normalizeConversationKeyword)
        .filter(Boolean),
    )).slice(0, 100);

    const source = input.source ?? 'subconscious';
    const rows: ConversationKeywordRecord[] = [];
    for (const term of terms) {
      const result = await postgresClient.query<ConversationKeywordRecord>(
        `INSERT INTO ${ ConversationKeywordsModel.TABLE }
           (id, term, thread_id, conversation_history_id, channel_id, agent_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (term, thread_id) DO UPDATE SET
           conversation_history_id = COALESCE(EXCLUDED.conversation_history_id, ${ ConversationKeywordsModel.TABLE }.conversation_history_id),
           channel_id              = COALESCE(EXCLUDED.channel_id, ${ ConversationKeywordsModel.TABLE }.channel_id),
           agent_id                = COALESCE(EXCLUDED.agent_id, ${ ConversationKeywordsModel.TABLE }.agent_id),
           source                  = EXCLUDED.source,
           last_seen               = NOW(),
           hit_count               = ${ ConversationKeywordsModel.TABLE }.hit_count + 1
         RETURNING *`,
        [makeId(), term, threadId, input.conversation_history_id ?? null, input.channel_id ?? null, input.agent_id ?? null, source],
      );
      if (result[0]) rows.push(result[0]);
    }
    return rows;
  }

  /**
   * Reader search: exact canonical-term match -> pg_trgm fuzzy match on term
   * -> ILIKE fallback over conversation_history.title/summary/last_summary.
   * Stops at the first tier that returns rows. Intentionally does not filter
   * on conversation_history.hidden — the reader's whole point is finding
   * sub-agent/subconscious conversations hidden from the primary UI.
   */
  static async searchByTerm(term: string, limit = 20): Promise<ConversationSearchHit[]> {
    const canonical = normalizeConversationKeyword(term);
    if (!canonical) return [];

    const exact = await postgresClient.query<ConversationSearchHit>(
      `SELECT ck.thread_id, ck.conversation_history_id, ck.channel_id, ck.agent_id,
              ch.title, ch.summary, ch.log_file, ck.first_seen, ck.last_seen,
              'exact' AS match_reason, ck.term AS matched_term
       FROM ${ ConversationKeywordsModel.TABLE } ck
       LEFT JOIN conversation_history ch ON ch.id = ck.conversation_history_id
       WHERE ck.term = $1
       ORDER BY ck.hit_count DESC, ck.last_seen DESC
       LIMIT $2`,
      [canonical, limit],
    );
    if (exact.length > 0) return exact;

    const fuzzy = await postgresClient.query<ConversationSearchHit>(
      `SELECT ck.thread_id, ck.conversation_history_id, ck.channel_id, ck.agent_id,
              ch.title, ch.summary, ch.log_file, ck.first_seen, ck.last_seen,
              'fuzzy' AS match_reason, ck.term AS matched_term
       FROM ${ ConversationKeywordsModel.TABLE } ck
       LEFT JOIN conversation_history ch ON ch.id = ck.conversation_history_id
       WHERE similarity(ck.term, $1) > 0.3
       ORDER BY similarity(ck.term, $1) DESC, ck.last_seen DESC
       LIMIT $2`,
      [canonical, limit],
    );
    if (fuzzy.length > 0) return fuzzy;

    return postgresClient.query<ConversationSearchHit>(
      `SELECT ch.thread_id, ch.id AS conversation_history_id, ch.channel_id, ch.agent_id,
              ch.title, ch.summary, ch.log_file, ch.created_at AS first_seen, ch.last_active_at AS last_seen,
              'title_summary_fallback' AS match_reason, NULL AS matched_term
       FROM conversation_history ch
       WHERE ch.title ILIKE $1 OR ch.summary ILIKE $1 OR ch.last_summary ILIKE $1
       ORDER BY ch.last_active_at DESC
       LIMIT $2`,
      [`%${ term }%`, limit],
    );
  }

  /**
   * SQL recall fast path for the Conversation Reader: rank prior threads by
   * how many distinctive query words their indexed keywords contain, each
   * word weighted by inverse thread frequency (words present in more than
   * maxCommonFraction of threads are ignored). Excludes the current thread.
   */
  static async recallThreads(
    words: string[],
    opts: { excludeThreadIds?: string[]; limit?: number; maxCommonFraction?: number } = {},
  ): Promise<ConversationThreadRecallHit[]> {
    const patterns = [...new Set(words.map(w => normalizeConversationKeyword(w)).filter(Boolean))]
      .map(w => ({ word: w, pattern: `%${ escapeLikeTerm(w) }%` }));

    if (patterns.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
    const minMatched = patterns.length <= 2 ? 1 : 2;

    return postgresClient.query<ConversationThreadRecallHit>(
      `WITH q AS (
         SELECT unnest($1::text[]) AS word, unnest($2::text[]) AS pattern
       ),
       hits AS (
         SELECT DISTINCT q.word, ck.thread_id
         FROM q JOIN ${ ConversationKeywordsModel.TABLE } ck ON ck.term ILIKE q.pattern ESCAPE '\\'
         WHERE NOT (ck.thread_id = ANY($3::text[]))
       ),
       n AS (SELECT greatest(count(DISTINCT thread_id), 1)::float AS n FROM ${ ConversationKeywordsModel.TABLE }),
       idf AS (
         SELECT word, ln((SELECT n FROM n) / count(*)) + 0.1 AS w
         FROM hits GROUP BY word
         HAVING count(*) <= greatest((SELECT n FROM n) * $4, 1)
       ),
       scored AS (
         SELECT h.thread_id, sum(idf.w)::float AS score, array_agg(h.word ORDER BY idf.w DESC) AS matched_terms
         FROM hits h JOIN idf ON idf.word = h.word
         GROUP BY h.thread_id
         HAVING count(*) >= $5
       )
       SELECT s.thread_id, s.score, s.matched_terms,
              ch.title, ch.summary,
              coalesce(ch.last_active_at, (SELECT max(last_seen) FROM ${ ConversationKeywordsModel.TABLE } k WHERE k.thread_id = s.thread_id)) AS last_seen
       FROM scored s
       LEFT JOIN LATERAL (
         SELECT title, coalesce(nullif(last_summary, ''), summary) AS summary, last_active_at
         FROM conversation_history WHERE thread_id = s.thread_id
         ORDER BY last_active_at DESC NULLS LAST LIMIT 1
       ) ch ON true
       ORDER BY s.score DESC, last_seen DESC
       LIMIT $6`,
      [patterns.map(p => p.word), patterns.map(p => p.pattern), opts.excludeThreadIds ?? [], opts.maxCommonFraction ?? 0.2, minMatched, limit],
    );
  }

  /** Reader lookup: every indexed keyword for a given thread, most recent first. */
  static async searchByThread(threadId: string, limit = 100): Promise<ConversationKeywordRecord[]> {
    const id = threadId?.trim();
    if (!id) return [];
    return postgresClient.query<ConversationKeywordRecord>(
      `SELECT * FROM ${ ConversationKeywordsModel.TABLE }
       WHERE thread_id = $1
       ORDER BY last_seen DESC
       LIMIT $2`,
      [id, limit],
    );
  }
}
