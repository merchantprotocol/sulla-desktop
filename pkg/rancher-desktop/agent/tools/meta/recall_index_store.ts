import { getRecallIndexService } from '../../services/RecallIndexService';
import { BaseTool, ToolResponse } from '../base';

/**
 * RecallIndexStore Tool — persist freshly-researched citation digests into
 * the Redis citation index so future recall passes (this session or the
 * next) can reuse them without re-reading the source files. File digests
 * are keyed by content hash; topic citations accumulate under a normalized
 * topic key. Entries expire after 24h unless re-hit.
 */
export class RecallIndexStoreWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const files: { path: string; digest: string }[] = Array.isArray(input.files) ? input.files : [];
    const topic: string = input.topic || '';
    const citations: string[] = Array.isArray(input.citations) ? input.citations : [];

    if (files.length === 0 && !topic) {
      return { successBoolean: false, responseString: 'Provide files (path+digest pairs), a topic with citations, or both.' };
    }
    if (topic && citations.length === 0) {
      return { successBoolean: false, responseString: 'A topic requires at least one citation string.' };
    }

    const index = getRecallIndexService();
    const stored: string[] = [];
    const failed: string[] = [];

    for (const file of files) {
      if (!file?.path || !file?.digest) {
        failed.push(`${ file?.path || '(missing path)' } — both path and digest are required`);
        continue;
      }
      try {
        await index.storeFile(file.path, file.digest);
        stored.push(file.path);
      } catch (error) {
        failed.push(`${ file.path } — ${ error instanceof Error ? error.message : String(error) }`);
      }
    }

    try {
      if (topic) {
        await index.storeTopic(topic, citations);
      }
    } catch (error) {
      failed.push(`topic "${ topic }" — ${ error instanceof Error ? error.message : String(error) }`);
    }

    const parts: string[] = [];
    if (stored.length > 0) parts.push(`Indexed ${ stored.length } file digest(s):\n${ stored.map(p => `- ${ p }`).join('\n') }`);
    if (topic && !failed.some(f => f.startsWith('topic'))) parts.push(`Stored ${ citations.length } citation(s) under topic "${ topic }".`);
    if (failed.length > 0) parts.push(`Failed:\n${ failed.map(f => `- ${ f }`).join('\n') }`);

    return {
      successBoolean: failed.length === 0,
      responseString: parts.join('\n\n') || 'Nothing stored.',
    };
  }
}
