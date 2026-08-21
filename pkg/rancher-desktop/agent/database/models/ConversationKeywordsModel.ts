import { postgresClient } from '../PostgresClient';

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
}
