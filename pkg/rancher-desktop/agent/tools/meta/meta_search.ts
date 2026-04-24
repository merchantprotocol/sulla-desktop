import * as os from 'os';

import { BaseTool, ToolResponse } from '../base';

import { resolveSullaDocsDir } from '@pkg/agent/utils/sullaPaths';
import { indexDirectory, search, type QmdSearchResult } from '@pkg/main/qmdService';

/**
 * Search Tool — fast semantic search across any directory using QMD vector indexing.
 *
 * Always searches the bundled sulla-docs directory in addition to the requested
 * (or default) target dir, so the agent can discover tool / subsystem docs
 * without needing to remember where they live. Caller can opt out by passing
 * { includeSullaDocs: false }.
 */
export class MetaSearchWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { query, limit, reindex } = input;
    const includeSullaDocs = input.includeSullaDocs !== false;
    let dirPath = input.dirPath || os.homedir();
    // Expand ~ to home directory — path.resolve doesn't handle tilde
    if (dirPath.startsWith('~/')) {
      dirPath = dirPath.replace('~', os.homedir());
    } else if (dirPath === '~') {
      dirPath = os.homedir();
    }

    if (!query) {
      return {
        successBoolean: false,
        responseString: 'Missing required field: query',
      };
    }

    // Resolve the sulla-docs dir once. If it can't be located, log and skip —
    // search must still work even without bundled docs.
    let sullaDocsDir: string | null = null;
    if (includeSullaDocs) {
      try {
        sullaDocsDir = resolveSullaDocsDir();
      } catch (err) {
        console.warn('[file_search] sulla-docs not resolvable, skipping:', err instanceof Error ? err.message : err);
      }
    }

    // Avoid double-searching when the caller explicitly targets sulla-docs.
    const includeSecondPass = sullaDocsDir !== null && sullaDocsDir !== dirPath;

    try {
      if (reindex) {
        await indexDirectory(dirPath);
        if (includeSecondPass && sullaDocsDir) {
          await indexDirectory(sullaDocsDir);
        }
      }

      const perDirLimit = limit || 20;
      const primary: QmdSearchResult[] = await search(query, dirPath, perDirLimit);
      let docsHits: QmdSearchResult[] = [];

      if (includeSecondPass && sullaDocsDir) {
        try {
          docsHits = await search(query, sullaDocsDir, perDirLimit);
          if (docsHits.length === 0) {
            // Index lazily on first miss, then retry once.
            await indexDirectory(sullaDocsDir);
            docsHits = await search(query, sullaDocsDir, perDirLimit);
          }
        } catch (err) {
          console.warn('[file_search] sulla-docs search failed:', err instanceof Error ? err.message : err);
        }
      }

      if (primary.length === 0 && docsHits.length === 0) {
        // Try indexing the primary dir and searching again before giving up.
        await indexDirectory(dirPath);
        const retryPrimary = await search(query, dirPath, perDirLimit);

        if (retryPrimary.length === 0 && docsHits.length === 0) {
          const checked = sullaDocsDir ? `${ dirPath } and ${ sullaDocsDir }` : dirPath;
          return {
            successBoolean: true,
            responseString: `No results found for "${ query }" in ${ checked }`,
          };
        }

        return {
          successBoolean: true,
          responseString: formatResults(retryPrimary, docsHits, query, dirPath, sullaDocsDir),
        };
      }

      return {
        successBoolean: true,
        responseString: formatResults(primary, docsHits, query, dirPath, sullaDocsDir),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Search failed: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}

function formatResults(
  primary: QmdSearchResult[],
  docs: QmdSearchResult[],
  query: string,
  dirPath: string,
  sullaDocsDir: string | null,
): string {
  const blocks: string[] = [];
  const total = primary.length + docs.length;
  blocks.push(`Found ${ total } result(s) for "${ query }":`);

  if (primary.length > 0) {
    blocks.push(`\n## Results in ${ dirPath } (${ primary.length })\n${ renderHits(primary) }`);
  }

  if (docs.length > 0 && sullaDocsDir) {
    blocks.push(`\n## Results in sulla-docs — ${ sullaDocsDir } (${ docs.length })\n${ renderHits(docs) }`);
  }

  return blocks.join('\n');
}

function renderHits(results: QmdSearchResult[]): string {
  return results
    .map((r, i) => {
      const parts = [`${ i + 1 }. ${ r.path }`];
      if (r.line) parts.push(`   Line ${ r.line }`);
      if (r.preview) parts.push(`   ${ r.preview }`);
      return parts.join('\n');
    })
    .join('\n\n');
}
