import { getRecallIndexService } from '../../services/RecallIndexService';
import { BaseTool, ToolResponse } from '../base';

/**
 * RecallIndexLookup Tool — check the Redis citation index BEFORE re-reading
 * files or re-searching directories. Returns cached digests for files whose
 * content is verified unchanged (cheap stat/hash check, no LLM), and the
 * citation set previously stored under a topic. Stale entries (file changed
 * or deleted) are dropped automatically and reported so the caller knows to
 * re-research only those.
 */
export class RecallIndexLookupWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const topic: string = input.topic || '';
    const paths: string[] = Array.isArray(input.paths) ? input.paths : [];

    if (!topic && paths.length === 0) {
      return { successBoolean: false, responseString: 'Provide a topic, a list of paths, or both.' };
    }

    const index = getRecallIndexService();
    const sections: string[] = [];

    try {
      if (topic) {
        const entry = await index.lookupTopic(topic);
        if (entry && entry.citations.length > 0) {
          sections.push(`## Topic: ${ topic } (${ entry.citations.length } cached citations)\n${ entry.citations.join('\n---\n') }`);
        } else {
          sections.push(`## Topic: ${ topic }\nMISS — no cached citations. Research this topic and store the results with recall_index_store.`);
        }
      }

      if (paths.length > 0) {
        const results = await Promise.all(paths.map(p => index.lookupFile(p)));
        const fresh = results.filter(r => r.status === 'fresh');
        const stale = results.filter(r => r.status === 'stale');
        const misses = results.filter(r => r.status === 'miss');

        for (const hit of fresh) {
          sections.push(`## File: ${ hit.path } (FRESH — content verified unchanged, digest is trusted)\n${ hit.digest }`);
        }
        if (stale.length > 0) {
          sections.push(`## Stale (file changed or deleted — entries dropped, re-read these):\n${ stale.map(r => `- ${ r.path }`).join('\n') }`);
        }
        if (misses.length > 0) {
          sections.push(`## Not indexed (read these, then store digests with recall_index_store):\n${ misses.map(r => `- ${ r.path }`).join('\n') }`);
        }
      }

      return { successBoolean: true, responseString: sections.join('\n\n') };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Recall index lookup failed: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}
