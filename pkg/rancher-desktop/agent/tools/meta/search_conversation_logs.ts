import fs from 'node:fs';
import path from 'node:path';

import { ConversationHistoryModel } from '../../database/models/ConversationHistoryModel';
import { resolveSullaLogsDir } from '../../utils/sullaPaths';
import { BaseTool, ToolResponse } from '../base';

/**
 * Log files with no embedded thread/conversation id — global infra logs,
 * never candidates for thread-scoped or recency-window search. Audited
 * 2026-08-21 against the live log dir (task DxHy).
 */
const GLOBAL_LOG_FILES = new Set([
  'frontend-graph.log',
  'chat.log',
  'dispatcher.log',
  'index.log',
  'index.jsonl',
  'persona.log',
  'playbook-debug.log',
  'background-web-requests.log',
]);

const MAX_FILES_SCANNED = 500;
const MAX_BYTES_PER_FILE = 512 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Matches the sanitization SullaLogger applies when building filenames
// (resolveFilePath / resolveJsonlPath in SullaLogger.ts) — must stay in
// sync with that logic or thread-id lookups silently miss.
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isThreadScopedLogFile(name: string): boolean {
  if (GLOBAL_LOG_FILES.has(name)) return false;
  return name.endsWith('.log') || name.endsWith('.jsonl');
}

/** Read up to the last maxBytes of a file — cheap tail for large logs. */
function readTail(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read-only search over ~/sulla/logs/ for the Conversation Reader. Two
 * lookup modes:
 *  - thread_id: resolve the specific <channel>_<id>.log / conv_<id>.jsonl
 *    file(s) for that conversation (filename sanitization matches
 *    SullaLogger; conversation_history.log_file is consulted as a
 *    secondary, more robust source).
 *  - no thread_id: scan all thread-scoped files within a recency window
 *    (since / days), excluding the fixed set of global non-thread logs.
 * Optional `keyword` filters matched files down to content lines. Content
 * search is only as useful as what BaseNode actually logs for assistant
 * turns — see task 7BAO; filename/recency lookup does not depend on that.
 */
export class SearchConversationLogsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const threadId = typeof input.thread_id === 'string' ? input.thread_id.trim() : '';
    const keyword = typeof input.keyword === 'string' ? input.keyword.trim().toLowerCase() : '';
    const days = input.days !== undefined && Number.isFinite(Number(input.days)) ? Number(input.days) : undefined;
    const since = typeof input.since === 'string' ? input.since.trim() : '';
    const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    let dir: string;
    try {
      dir = resolveSullaLogsDir();
    } catch (err: any) {
      return { successBoolean: false, responseString: `Could not resolve log directory: ${ err?.message || err }` };
    }

    if (!fs.existsSync(dir)) {
      return { successBoolean: true, responseString: `Log directory ${ dir } does not exist yet — no logs to search.` };
    }

    let cutoffMs: number | undefined;
    if (since) {
      const t = Date.parse(since);
      if (!Number.isNaN(t)) cutoffMs = t;
    } else if (days !== undefined) {
      cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    }

    let candidates: string[];

    if (threadId) {
      const safeId = sanitizeId(threadId);
      const logPattern = new RegExp(`_${ escapeRegExp(safeId) }\\.log$`);
      const jsonlName = `conv_${ safeId }.jsonl`;
      const allFiles = fs.readdirSync(dir);
      candidates = allFiles.filter(f => logPattern.test(f) || f === jsonlName);

      try {
        const assoc = await ConversationHistoryModel.getFileAssociations(threadId);
        if (assoc.log_file) {
          const base = path.basename(assoc.log_file);
          if (!candidates.includes(base) && fs.existsSync(path.join(dir, base))) {
            candidates.push(base);
          }
        }
      } catch {
        // DB lookup is a best-effort enrichment; filename matching alone still works.
      }

      if (candidates.length === 0) {
        return {
          successBoolean: true,
          responseString: `No log files found for thread ${ threadId } (looked for *_${ safeId }.log and ${ jsonlName }).`,
        };
      }
    } else {
      const withStats = fs.readdirSync(dir)
        .filter(isThreadScopedLogFile)
        .map(f => {
          try {
            return { f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((x): x is { f: string; mtimeMs: number } => x !== null)
        .filter(x => cutoffMs === undefined || x.mtimeMs >= cutoffMs)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_FILES_SCANNED);
      candidates = withStats.map(x => x.f);

      if (candidates.length === 0) {
        return {
          successBoolean: true,
          responseString: cutoffMs !== undefined
            ? `No thread-scoped log files modified since ${ new Date(cutoffMs).toISOString() }.`
            : 'No thread-scoped log files found.',
        };
      }

      if (!keyword) {
        const preview = candidates.slice(0, limit).join('\n');
        const overflow = candidates.length > limit
          ? `\n… (${ candidates.length - limit } more — narrow with keyword or a shorter window)`
          : '';
        return {
          successBoolean: true,
          responseString: `${ candidates.length } thread-scoped log file(s) in the recency window:\n${ preview }${ overflow }`,
        };
      }
    }

    if (!keyword) {
      const sections = candidates.map((f) => {
        try {
          const tail = readTail(path.join(dir, f), 4096).trim();
          const lastLines = tail.split('\n').slice(-10).join('\n');
          return `── ${ f } ──\n${ lastLines }`;
        } catch (err: any) {
          return `── ${ f } ── (read failed: ${ err?.message || err })`;
        }
      });
      return { successBoolean: true, responseString: sections.join('\n\n') };
    }

    const matches: string[] = [];
    for (const f of candidates) {
      if (matches.length >= limit) break;
      let content: string;
      try {
        content = readTail(path.join(dir, f), MAX_BYTES_PER_FILE);
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        if (matches.length >= limit) break;
        if (line.toLowerCase().includes(keyword)) {
          matches.push(`${ f }: ${ line.slice(0, 500) }`);
        }
      }
    }

    if (matches.length === 0) {
      return {
        successBoolean: true,
        responseString: `No lines matching "${ keyword }" found across ${ candidates.length } candidate log file(s).`,
      };
    }
    return {
      successBoolean: true,
      responseString: `${ matches.length } matching line(s) for "${ keyword }":\n${ matches.join('\n') }`,
    };
  }
}
