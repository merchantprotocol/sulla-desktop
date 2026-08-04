import * as fs from 'fs';
import * as path from 'path';

import { resolveSullaLogsDir } from '../../utils/sullaPaths';
import { BaseTool, ToolResponse } from '../base';

/**
 * RecallConversations Tool — search and read the TRAINING-FORMATTED conversation
 * logs on disk (`~/sulla/logs/conv_*.jsonl`), the append-only JSONL transcripts
 * SullaLogger writes for every user-facing conversation. Subconscious agents are
 * never written to these files, so the corpus is exactly the real dialogue
 * history: what the human and Sulla actually said, turn by turn.
 *
 * This is distinct from `search_conversations` (which queries the DB metadata:
 * titles + summaries) — this tool searches and returns the message CONTENT.
 *
 * PERFORMANCE: this runs as an AWAITED subconscious lane that blocks the primary
 * agent, over a corpus that is hundreds of MB and grows without bound (single
 * coding-session logs reach tens of MB). So ALL reads are bounded: files are
 * scanned newest-first under a global byte budget, giant files are sampled
 * head+tail rather than read whole, and transcript reads are tail-biased (recent
 * turns carry the decisions). Coverage limits are reported, never silent.
 *
 * Runs in the Electron main process, so these host-side file reads work whether
 * or not the primary agent executes inside Lima.
 *
 *   action: "search"  — content-search across recent conversation logs for terms
 *   action: "read"    — render one conversation's transcript by id
 */

/** Max transcripts ranked per search (newest-first), before the byte budget. */
const MAX_SCAN_FILES = 150;
/** Stop scanning once this many bytes have been read across all files. */
const GLOBAL_SCAN_BUDGET_BYTES = 80 * 1024 * 1024;
/** Files at or under this size are read whole for scanning. */
const PER_FILE_WHOLE_BYTES = 1024 * 1024;
/** For larger files, sample this many bytes from the head and from the tail. */
const SAMPLE_HALF_BYTES = 512 * 1024;

/** Files at or under this size are read whole for the `read` action. */
const READ_WHOLE_BYTES = 3 * 1024 * 1024;
/** For larger files, keep this much of the tail (recent turns) + a small head. */
const READ_TAIL_BYTES = 700 * 1024;
const READ_HEAD_BYTES = 48 * 1024;

const SEARCH_RESULT_LIMIT = 8;
const PER_MESSAGE_CHAR_CAP = 600;
const TRANSCRIPT_CHAR_BUDGET = 9000;
const SNIPPET_RADIUS = 160;

interface LoggedMessage { role: string; text: string; ts?: string }

/**
 * Automation logs that live alongside real conversations but are NOT
 * human↔Sulla dialogue — spawned sub-agent job prompts, workflow node runs, and
 * routine executions. They dominate the corpus by count and would dilute recall,
 * so search skips them. Real chats are desktop threads (`thread_*`) and
 * UUID-named chats; those carry what the human and Sulla actually discussed.
 */
const NON_CONVERSATION_ID_PREFIXES = [
  'spawn-agent',
  'workflow-playbook-node',
  'routine-exec',
  'agent-job',
  'subconscious',
];

function isConversationalId(id: string): boolean {
  return !NON_CONVERSATION_ID_PREFIXES.some(p => id.startsWith(p));
}

/** Read up to `maxBytes` from the FRONT of a file without loading it whole. */
function readHead(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf-8', 0, n);
  } finally { fs.closeSync(fd); }
}

/** Read up to `maxBytes` from the END of a file. */
function readTail(filePath: string, maxBytes: number, size: number): string {
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf-8', 0, n);
  } finally { fs.closeSync(fd); }
}

/** Render a stored message's `content` (string OR content-block array) to text. */
function renderContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block?.type === 'tool_use') parts.push(`[tool_use: ${ block.name || 'tool' }]`);
      else if (block?.type === 'tool_result') parts.push('[tool_result]');
      else if (block?.type === 'image') parts.push('[image]');
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

/** Extract message events from a raw JSONL chunk. Partial edge lines just fail
 *  to parse and are skipped — safe for head/tail samples. */
function messagesFromChunk(chunk: string): LoggedMessage[] {
  const out: LoggedMessage[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt?.type !== 'message') continue;
    const text = renderContent(evt.content).trim();
    if (!text) continue;
    out.push({ role: String(evt.role || 'user'), text, ts: evt.ts });
  }
  return out;
}

/** conv_<id>.jsonl  ->  <id> */
function idFromFilename(filename: string): string {
  return filename.replace(/^conv_/, '').replace(/\.jsonl$/, '');
}

/** Mirror SullaLogger.resolveJsonlPath: conv_<safeId>.jsonl */
function fileFromId(id: string): string {
  const safeId = id.replace(/^conv_/, '').replace(/\.jsonl$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return `conv_${ safeId }.jsonl`;
}

function firstUserLine(messages: LoggedMessage[]): string {
  const u = messages.find(m => m.role === 'user');
  const t = (u?.text || messages[0]?.text || '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${ t.slice(0, 120) }…` : t;
}

function buildTranscript(messages: LoggedMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    let text = m.text.replace(/\s+$/g, '');
    if (text.length > PER_MESSAGE_CHAR_CAP) text = `${ text.slice(0, PER_MESSAGE_CHAR_CAP) }… [truncated]`;
    lines.push(`${ m.role.toUpperCase() }: ${ text }`);
  }
  let transcript = lines.join('\n\n');
  if (transcript.length > TRANSCRIPT_CHAR_BUDGET) {
    transcript = `… [earlier turns omitted]\n\n${ transcript.slice(-TRANSCRIPT_CHAR_BUDGET) }`;
  }
  return transcript;
}

export class RecallConversationsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const action = (input.action as string) || 'search';
    let logsDir: string;
    try {
      logsDir = resolveSullaLogsDir();
    } catch (error) {
      return { successBoolean: false, responseString: `Could not resolve the conversation logs directory: ${ (error as Error).message }` };
    }

    try {
      switch (action) {
      case 'search': {
        const query = String(input.query || '').trim();
        if (!query) {
          return { successBoolean: false, responseString: '"query" is required for search action.' };
        }
        const limit = Math.max(1, Math.min(Number(input.limit) || SEARCH_RESULT_LIMIT, 20));
        const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
        if (terms.length === 0) terms.push(query.toLowerCase());

        // Newest-first: recent conversations are the most relevant, and this is
        // the order we want to spend the byte budget on.
        let entries: { file: string; size: number; mtime: number }[] = [];
        try {
          entries = fs.readdirSync(logsDir)
            .filter(f => f.startsWith('conv_') && f.endsWith('.jsonl') && isConversationalId(idFromFilename(f)))
            .map((f) => {
              const st = fs.statSync(path.join(logsDir, f));
              return { file: f, size: st.size, mtime: st.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
        } catch (error) {
          return { successBoolean: false, responseString: `No conversation logs found at ${ logsDir }: ${ (error as Error).message }` };
        }

        interface Hit { id: string; score: number; distinct: number; title: string; date: string; msgCount: number; snippet: string }
        const hits: Hit[] = [];
        let bytesRead = 0;
        let filesScanned = 0;
        let budgetHit = false;

        for (const { file, size } of entries) {
          if (filesScanned >= MAX_SCAN_FILES || bytesRead >= GLOBAL_SCAN_BUDGET_BYTES) { budgetHit = true; break; }
          filesScanned++;

          let chunk: string;
          try {
            if (size <= PER_FILE_WHOLE_BYTES) {
              chunk = fs.readFileSync(path.join(logsDir, file), 'utf-8');
              bytesRead += size;
            } else {
              // Sample head + tail so both the setup and the outcome are searchable.
              const head = readHead(path.join(logsDir, file), SAMPLE_HALF_BYTES);
              const tail = readTail(path.join(logsDir, file), SAMPLE_HALF_BYTES, size);
              chunk = `${ head }\n${ tail }`;
              bytesRead += SAMPLE_HALF_BYTES * 2;
            }
          } catch { continue; }

          const messages = messagesFromChunk(chunk);
          if (messages.length === 0) continue;

          const haystack = messages.map(m => m.text).join('\n').toLowerCase();
          let score = 0;
          let distinct = 0;
          let firstIdx = -1;
          for (const term of terms) {
            let idx = haystack.indexOf(term);
            if (idx === -1) continue;
            distinct++;
            if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
            while (idx !== -1) { score++; idx = haystack.indexOf(term, idx + term.length); }
          }
          if (distinct === 0) continue;

          const snippet = firstIdx >= 0
            ? haystack.slice(Math.max(0, firstIdx - SNIPPET_RADIUS), firstIdx + SNIPPET_RADIUS).replace(/\s+/g, ' ').trim()
            : '';

          hits.push({
            id:       idFromFilename(file),
            score,
            distinct,
            title:    firstUserLine(messages),
            date:     messages[0]?.ts || '',
            msgCount: messages.length,
            snippet,
          });
        }

        if (hits.length === 0) {
          const note = budgetHit ? ` (scanned the ${ filesScanned } most recent logs only)` : '';
          return { successBoolean: true, responseString: `No past conversations mention "${ query }"${ note }.` };
        }

        hits.sort((a, b) => b.distinct - a.distinct || b.score - a.score || b.date.localeCompare(a.date));
        const top = hits.slice(0, limit);

        const lines = top.map((h) => {
          const when = h.date ? new Date(h.date).toLocaleString() : 'unknown date';
          return `- id=${ h.id } — ${ when } (${ h.msgCount }+ msgs, ${ h.distinct }/${ terms.length } terms)\n    "${ h.title }"\n    …${ h.snippet }…`;
        });

        const coverage = budgetHit
          ? `\n(Coverage: scanned the ${ filesScanned } most-recent conversation logs within budget; older logs not searched this pass.)`
          : '';

        return {
          successBoolean: true,
          responseString: `Found ${ hits.length } past conversation(s) mentioning "${ query }" (showing top ${ top.length }). Call action:"read" with an id to read the full transcript:\n${ lines.join('\n') }${ coverage }`,
        };
      }

      case 'read': {
        const id = String(input.id || '').trim();
        if (!id) {
          return { successBoolean: false, responseString: '"id" is required for read action (get one from action:"search").' };
        }
        const filePath = path.join(logsDir, fileFromId(id));
        let size: number;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          return { successBoolean: true, responseString: `No conversation log found for id "${ id }".` };
        }

        let messages: LoggedMessage[];
        let truncatedNote = '';
        if (size <= READ_WHOLE_BYTES) {
          messages = messagesFromChunk(fs.readFileSync(filePath, 'utf-8'));
        } else {
          // Giant log: keep the tail (recent turns) plus a small head for the title.
          const head = messagesFromChunk(readHead(filePath, READ_HEAD_BYTES));
          const tail = messagesFromChunk(readTail(filePath, READ_TAIL_BYTES, size));
          const headTitle = head.slice(0, 1);
          messages = [...headTitle, ...tail];
          truncatedNote = `\n[Large conversation (${ Math.round(size / 1024 / 1024) }MB) — showing the opening turn and the most recent turns only.]`;
        }

        if (messages.length === 0) {
          return { successBoolean: true, responseString: `Conversation "${ id }" has no readable messages.` };
        }

        const when = messages[0]?.ts ? new Date(messages[0].ts).toLocaleString() : 'unknown date';
        const header = `Conversation ${ id } — started ${ when }\nTitle: "${ firstUserLine(messages) }"${ truncatedNote }`;

        return {
          successBoolean: true,
          responseString: `${ header }\n\n${ buildTranscript(messages) }`,
        };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use "search" or "read".` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `recall_conversations failed: ${ (error as Error).message }` };
    }
  }
}
