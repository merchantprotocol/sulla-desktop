import { OBSERVATION_DOMAIN, recallRankedMemories } from '../../memory/MemoryRecallService';
import { BaseTool, ToolResponse } from '../base';

const DOMAINS = [OBSERVATION_DOMAIN, 'human', 'agent', 'business', 'environment', 'projects', 'world', 'skills'];

/**
 * Recall Memories Tool
 *
 * On-demand access to the same ranked recall engine that fills the pre-turn
 * memory context (BM25 + potion embeddings + learned ranker). Matches by
 * meaning, not just shared words, across observations and every identity
 * domain. Every row is dated.
 */
export class RecallMemoriesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const domain = typeof input.domain === 'string' && input.domain.trim() ? input.domain.trim().toLowerCase() : undefined;
    const limit = Math.min(Math.max(Number(input.limit) || 16, 1), 50);

    if (!query) {
      return { successBoolean: false, responseString: 'A non-empty query is required.' };
    }
    if (domain && !DOMAINS.includes(domain)) {
      return { successBoolean: false, responseString: `Unknown domain "${ domain }". Use one of: ${ DOMAINS.join(', ') }.` };
    }

    const hits = await recallRankedMemories([query], new Date(), { domain, limit });

    if (!hits) {
      return { successBoolean: false, responseString: 'Ranked recall is unavailable (embedding model not bundled or DB error). Use search_observations / search_identity_observations instead.' };
    }
    if (hits.length === 0) {
      return { successBoolean: true, responseString: `No memories found for "${ query }".` };
    }

    const lines = hits.map(h => {
      const tag = h.domain === OBSERVATION_DOMAIN ? `${ h.category ?? 'medium' }` : `${ h.domain } L${ h.level ?? 1 }${ h.category ? `·${ h.category }` : '' }`;

      return `[id:${ h.id }] ${ tag } ${ h.date || 'undated' } (score ${ h.score.toFixed(2) }) — ${ h.content.replace(/\s+/g, ' ').trim() }`;
    });

    return {
      successBoolean: true,
      responseString: `Top ${ hits.length } memories for "${ query }"${ domain ? ` in ${ domain }` : ' across all domains' }, best first:\n${ lines.join('\n') }`,
    };
  }
}
