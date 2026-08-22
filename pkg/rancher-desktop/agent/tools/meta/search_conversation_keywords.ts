import { ConversationKeywordsModel } from '../../database/models/ConversationKeywordsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Read-only search for the Conversation Reader. Two modes:
 *  - term/query: exact canonical-term match -> pg_trgm fuzzy -> ILIKE
 *    fallback over conversation_history.title/summary/last_summary.
 *  - thread_id: every indexed keyword for that thread, most recent first.
 * At least one of the two must be supplied. Deliberately includes rows
 * hidden from the primary UI (subconscious/worker channels) — that is the
 * point of this tool.
 */
export class SearchConversationKeywordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const term = typeof input.term === 'string' ? input.term.trim()
      : (typeof input.query === 'string' ? input.query.trim() : '');
    const threadId = typeof input.thread_id === 'string' ? input.thread_id.trim() : '';
    const limit = Number(input.limit) || 20;

    if (!term && !threadId) {
      return { successBoolean: false, responseString: 'Provide either term (or query) or thread_id to search by.' };
    }

    try {
      if (threadId) {
        const rows = await ConversationKeywordsModel.searchByThread(threadId, limit);
        if (rows.length === 0) {
          return { successBoolean: true, responseString: `No indexed keywords found for thread ${ threadId }.` };
        }
        const lines = rows.map(r =>
          `[${ r.source }] ${ r.term } (hits:${ r.hit_count }, last_seen:${ r.last_seen }) channel:${ r.channel_id ?? '—' } agent:${ r.agent_id ?? '—' }`,
        );
        return {
          successBoolean: true,
          responseString: `${ rows.length } indexed keyword(s) for thread ${ threadId }:\n${ lines.join('\n') }`,
        };
      }

      const hits = await ConversationKeywordsModel.searchByTerm(term, limit);
      if (hits.length === 0) {
        return { successBoolean: true, responseString: `No conversations found matching "${ term }".` };
      }
      const lines = hits.map(h =>
        `[${ h.match_reason }] thread:${ h.thread_id } channel:${ h.channel_id ?? '—' } agent:${ h.agent_id ?? '—' } — ${ h.title || '(untitled)' }${ h.summary ? ` — ${ h.summary }` : '' }${ h.log_file ? ` (log: ${ h.log_file })` : '' }`,
      );
      return {
        successBoolean: true,
        responseString: `Found ${ hits.length } conversation(s) matching "${ term }":\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Search failed: ${ err?.message || err }` };
    }
  }
}
