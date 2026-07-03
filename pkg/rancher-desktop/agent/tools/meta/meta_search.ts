import * as os from 'os';

import { BaseTool, ToolResponse } from '../base';

import { resolveSullaDocsDir } from '@pkg/agent/utils/sullaPaths';
import {
  indexDirectory, search, getLastCoverage, SearchTimeoutError, SearchTooManyFilesError, type FileSearchResult,
} from '@pkg/main/fileSearchService';

/**
 * Search Tool — fast full-text (BM25) search across any directory via the
 * tiered fileSearchService engine (live scan for small dirs, incremental
 * contentless-FTS5 index for large ones).
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
        await safeIndex(dirPath);
        if (includeSecondPass && sullaDocsDir) {
          await safeIndex(sullaDocsDir);
        }
      }

      const perDirLimit = limit || 20;
      const primary: FileSearchResult[] = await search(query, dirPath, perDirLimit);
      let docsHits: FileSearchResult[] = [];

      if (includeSecondPass && sullaDocsDir) {
        try {
          docsHits = await search(query, sullaDocsDir, perDirLimit);
          if (docsHits.length === 0) {
            // Index lazily on first miss, then retry once.
            await safeIndex(sullaDocsDir);
            docsHits = await search(query, sullaDocsDir, perDirLimit);
          }
        } catch (err) {
          console.warn('[file_search] sulla-docs search failed:', err instanceof Error ? err.message : err);
        }
      }

      if (primary.length === 0 && docsHits.length === 0) {
        // Try indexing the primary dir and searching again before giving up.
        // safeIndex returns a sentinel on guardrail/timeout so we surface a
        // useful error to the LLM instead of pretending the search succeeded.
        const indexOutcome = await safeIndex(dirPath);
        if (indexOutcome.kind === 'tooManyFiles') {
          return {
            successBoolean: false,
            responseString: `Search not run: ${ indexOutcome.message } Pass a more specific dirPath (e.g. a single repo or subdirectory).`,
          };
        }
        if (indexOutcome.kind === 'timeout') {
          return {
            successBoolean: false,
            responseString: `Search not run: indexing ${ dirPath } timed out. Narrow the dirPath to a smaller subtree.`,
          };
        }

        const retryPrimary = await search(query, dirPath, perDirLimit);

        if (retryPrimary.length === 0 && docsHits.length === 0) {
          const checked = sullaDocsDir ? `${ dirPath } and ${ sullaDocsDir }` : dirPath;
          return {
            successBoolean: true,
            responseString: `No results found for "${ query }" in ${ checked }${ coverageNote(dirPath) }`,
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
      if (error instanceof SearchTooManyFilesError) {
        return {
          successBoolean: false,
          responseString: `Search not run: ${ error.message } Pass a more specific dirPath (e.g. a single repo or subdirectory).`,
        };
      }
      if (error instanceof SearchTimeoutError) {
        return {
          successBoolean: false,
          responseString: `Search timed out: ${ error.message }. Narrow the dirPath or simplify the query.`,
        };
      }
      return {
        successBoolean: false,
        responseString: `Search failed: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}

type IndexOutcome =
  | { kind: 'ok'; result: { indexed: number; updated: number; removed: number } }
  | { kind: 'tooManyFiles'; message: string }
  | { kind: 'timeout'; message: string };

// Wrap indexDirectory so the caller can react to guardrail / timeout errors
// without nesting another try/catch. Other errors propagate.
async function safeIndex(dirPath: string): Promise<IndexOutcome> {
  try {
    const result = await indexDirectory(dirPath);
    return { kind: 'ok', result };
  } catch (err) {
    if (err instanceof SearchTooManyFilesError) {
      return { kind: 'tooManyFiles', message: err.message };
    }
    if (err instanceof SearchTimeoutError) {
      return { kind: 'timeout', message: err.message };
    }
    throw err;
  }
}

// Coverage honesty: when the last search against dirPath ran off a truncated
// or partial FTS index, say so instead of silently pretending full coverage.
function coverageNote(dirPath: string): string {
  const cov = getLastCoverage(dirPath);

  if (!cov || (!cov.truncated && cov.indexedCount >= cov.candidateCount)) {
    return '';
  }
  const indexed = cov.indexedCount.toLocaleString('en-US');
  const candidates = cov.candidateCount.toLocaleString('en-US');

  return `\n\nNote: index covers ${ indexed } of ${ candidates } candidate files (last pass ${ formatAge(Date.now() - cov.lastPassAt) } ago). ` +
    'Pass reindex:true or narrow dirPath for deeper coverage.';
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) {
    return 'under a minute';
  }
  if (minutes < 60) {
    return `${ minutes }m`;
  }
  const hours = Math.floor(minutes / 60);

  if (hours < 48) {
    return `${ hours }h`;
  }

  return `${ Math.floor(hours / 24) }d`;
}

function formatResults(
  primary: FileSearchResult[],
  docs: FileSearchResult[],
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

  const note = coverageNote(dirPath);
  if (note) {
    blocks.push(note);
  }

  return blocks.join('\n');
}

function renderHits(results: FileSearchResult[]): string {
  return results
    .map((r, i) => {
      const parts = [`${ i + 1 }. ${ r.path }`];
      if (r.line) parts.push(`   Line ${ r.line }`);
      if (r.preview) parts.push(`   ${ r.preview }`);
      return parts.join('\n');
    })
    .join('\n\n');
}
