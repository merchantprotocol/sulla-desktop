import * as os from 'os';

import { BaseTool, ToolResponse } from '../base';

import { indexDirectory, search, type QmdSearchResult } from '@pkg/main/qmdService';

/**
 * Search Tool — fast semantic search across any directory using QMD vector indexing.
 * Indexes and searches a directory, returning matching files with previews.
 */
export class MetaSearchWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { query, limit, reindex } = input;
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

    try {
      // Index the directory first if requested or if this is the first search
      if (reindex) {
        await indexDirectory(dirPath);
      }

      const results: QmdSearchResult[] = await search(query, dirPath, limit || 20);

      if (results.length === 0) {
        // Try indexing and searching again if no results found
        await indexDirectory(dirPath);
        const retryResults = await search(query, dirPath, limit || 20);

        if (retryResults.length === 0) {
          return {
            successBoolean: true,
            responseString: `No results found for "${ query }" in ${ dirPath }`,
          };
        }

        return {
          successBoolean: true,
          responseString: formatResults(retryResults, query, dirPath),
        };
      }

      return {
        successBoolean: true,
        responseString: formatResults(results, query, dirPath),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Search failed: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}

function formatResults(results: QmdSearchResult[], query: string, dirPath: string): string {
  const header = `Found ${ results.length } result(s) for "${ query }" in ${ dirPath }:\n`;
  const items = results.map((r, i) => {
    const parts = [`${ i + 1 }. ${ r.path }`];
    if (r.line) parts.push(`   Line ${ r.line }`);
    if (r.preview) parts.push(`   ${ r.preview }`);
    return parts.join('\n');
  });
  return header + items.join('\n\n');
}
