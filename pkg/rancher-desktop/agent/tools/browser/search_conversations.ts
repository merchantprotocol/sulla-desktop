import fs from 'node:fs';
import readline from 'node:readline';

import { BaseTool, ToolResponse } from '../base';

import { ChatMessageModel } from '@pkg/agent/database/models/ChatMessageModel';
import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import { postgresClient } from '@pkg/agent/database/PostgresClient';

/** Max messages returned by the `messages` action before tail-trimming. */
const MESSAGES_DEFAULT_LIMIT = 40;
/** Per-message character cap so one long turn can't swamp the transcript. */
const PER_MESSAGE_CHAR_CAP = 600;
/** Overall transcript character budget (keeps the recall payload compact). */
const TRANSCRIPT_CHAR_BUDGET = 8000;

/**
 * Render a single stored message's content (string OR content-block array) to
 * plain text. Tool-use / tool-result / image blocks are collapsed to short
 * placeholders — the recall agent wants the dialogue, not tool plumbing.
 */
function renderMessageText(content: any): string {
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

/**
 * Build a compact transcript string from a list of {role, content} messages.
 * Keeps the most RECENT messages (that's where decisions/outcomes live), caps
 * each turn, and trims from the front to stay under the char budget.
 */
function buildTranscript(messages: Array<{ role?: string; content?: any }>): string {
  const recent = messages.slice(-MESSAGES_DEFAULT_LIMIT);
  const lines: string[] = [];
  for (const m of recent) {
    const role = (m?.role || 'user').toUpperCase();
    let text = renderMessageText(m?.content).trim();
    if (!text) continue;
    if (text.length > PER_MESSAGE_CHAR_CAP) text = `${ text.slice(0, PER_MESSAGE_CHAR_CAP) }… [truncated]`;
    lines.push(`${ role }: ${ text }`);
  }
  let transcript = lines.join('\n\n');
  if (transcript.length > TRANSCRIPT_CHAR_BUDGET) {
    transcript = `… [earlier turns omitted]\n\n${ transcript.slice(-TRANSCRIPT_CHAR_BUDGET) }`;
  }
  return transcript;
}

type LogTranscript = {
  messages: Array<{ role?: string; content?: any }>;
  complete: boolean;
  incompleteReason?: string;
};

/** Read a conversation_history.log_file without claiming a complete transcript
 * when the file is absent, truncated, or contains malformed JSONL. */
async function readLogTranscript(logFile: string): Promise<LogTranscript> {
  if (!fs.existsSync(logFile)) {
    return { messages: [], complete: false, incompleteReason: `log file is missing (${ logFile })` };
  }

  const messages: Array<{ role?: string; content?: any }> = [];
  let malformedLines = 0;
  let sawCompletion = false;
  const fileStream = fs.createReadStream(logFile, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        malformedLines++;
        continue;
      }

      if (event.type === 'message' && event.role && event.content != null) {
        messages.push({ role: event.role, content: event.content });
      } else if (event.type === 'tool_call') {
        messages.push({
          role: 'assistant',
          content: `[tool_call: ${ event.toolName || 'tool' }]`,
        });
      } else if (event.type === 'graph_completed') {
        sawCompletion = event.status === 'completed';
      }
    }
  } finally {
    rl.close();
  }

  const incompleteReason = malformedLines > 0
    ? `${ malformedLines } malformed JSONL line(s)`
    : (!sawCompletion ? 'no completed graph event' : undefined);

  return {
    messages,
    complete: !incompleteReason,
    ...(incompleteReason ? { incompleteReason } : {}),
  };
}

/**
 * Search Conversations Tool — search past chat conversations, browser visits,
 * and workflow executions stored in the conversation history database.
 */
export class SearchConversationsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const action = (input.action as string) || 'search';

      switch (action) {
      case 'search': {
        if (!input.query) {
          return { successBoolean: false, responseString: '"query" is required for search action.' };
        }

        const results = await ConversationHistoryModel.search(input.query);

        if (results.length === 0) {
          return {
            successBoolean: true,
            responseString: `No conversations found matching "${ input.query }".`,
          };
        }

        const lines = results.map((r: any) => {
          const date = new Date(r.last_active_at || r.created_at).toLocaleString();
          const status = r.status === 'active' ? '' : ` [${ r.status }]`;
          const ref = `id=${ r.id }${ r.thread_id ? ` thread=${ r.thread_id }` : '' }`;

          return `  [${ r.type }] ${ r.title || 'Untitled' } — ${ date }${ status }${ r.url ? ` (${ r.url })` : '' }\n      ${ ref }${ r.summary ? `\n      summary: ${ r.summary }` : '' }`;
        });

        return {
          successBoolean: true,
          responseString: `Found ${ results.length } conversation(s). Use action:"messages" with a threadId/id to read a transcript:\n${ lines.join('\n') }`,
        };
      }

      case 'recent': {
        const limit = input.limit || 20;
        const type = input.type || undefined;
        const results = await ConversationHistoryModel.getRecent(limit, type);

        if (results.length === 0) {
          return {
            successBoolean: true,
            responseString: `No recent conversations found${ type ? ` of type "${ type }"` : '' }.`,
          };
        }

        const lines = results.map((r: any) => {
          const date = new Date(r.last_active_at || r.created_at).toLocaleString();
          const ref = `id=${ r.id }${ r.thread_id ? ` thread=${ r.thread_id }` : '' }`;

          return `  [${ r.type }] ${ r.title || 'Untitled' } — ${ date } (${ r.message_count || 0 } msgs)${ r.url ? ` ${ r.url }` : '' }\n      ${ ref }`;
        });

        return {
          successBoolean: true,
          responseString: `${ results.length } recent conversation(s). Use action:"messages" with a threadId/id to read a transcript:\n${ lines.join('\n') }`,
        };
      }

      case 'get': {
        if (!input.id && !input.threadId) {
          return { successBoolean: false, responseString: '"id" or "threadId" is required for get action.' };
        }

        let record;

        if (input.threadId) {
          record = await ConversationHistoryModel.getByThread(input.threadId);
        } else {
          record = await ConversationHistoryModel.getById(input.id);
        }

        if (!record) {
          return {
            successBoolean: true,
            responseString: `No conversation found with ${ input.threadId ? `threadId "${ input.threadId }"` : `id "${ input.id }"` }.`,
          };
        }

        const details = [
          `ID: ${ record.id }`,
          `Type: ${ record.type }`,
          `Title: ${ record.title || 'Untitled' }`,
          `Status: ${ record.status }`,
          `Messages: ${ record.message_count || 0 }`,
          `Created: ${ new Date(record.created_at).toLocaleString() }`,
          `Last Active: ${ new Date(record.last_active_at).toLocaleString() }`,
          record.thread_id ? `Thread ID: ${ record.thread_id }` : null,
          record.url ? `URL: ${ record.url }` : null,
          record.summary ? `Summary: ${ record.summary }` : null,
          record.log_file ? `Log File: ${ record.log_file }` : null,
        ].filter(Boolean);

        return {
          successBoolean: true,
          responseString: details.join('\n'),
        };
      }

      case 'messages': {
        if (!input.id && !input.threadId) {
          return { successBoolean: false, responseString: '"id" or "threadId" is required for messages action.' };
        }

        // Resolve the conversation record (for the title header + to learn the
        // thread_id when only the history id was supplied).
        let record = null as Awaited<ReturnType<typeof ConversationHistoryModel.getByThread>> | null;
        if (input.threadId) {
          record = await ConversationHistoryModel.getByThread(input.threadId);
        } else if (input.id) {
          record = await ConversationHistoryModel.getById(input.id);
        }

        const title = record?.title || 'Untitled';
        // Candidate keys to look up the stored transcript, most-specific first.
        const threadKey = input.threadId || record?.thread_id || record?.id || input.id;
        const stateId   = input.id || record?.id;

        // 1) Primary source: the full desktop thread state (chat_messages.state_json).
        let messages: Array<{ role?: string; content?: any }> = [];
        try {
          let threadState = null as any;
          if (stateId) threadState = await ChatMessageModel.loadThreadState(stateId);
          if (!threadState && threadKey) threadState = await ChatMessageModel.loadThreadState(threadKey);
          if (!threadState && threadKey) {
            const threads = await ChatMessageModel.loadThreadsByThreadId(threadKey);
            threadState = threads[0] || null;
          }
          const arr = threadState?.thread?.messages;
          if (Array.isArray(arr)) messages = arr;
        } catch { /* fall through to relay mirror */ }

        // 2) Fallback: the mobile-relay mirror (claude_messages), keyed by conversation_id.
        if (messages.length === 0) {
          const convId = record?.id || input.id || input.threadId;
          if (convId) {
            try {
              const rows = await postgresClient.query<{ role: string; content: string }>(`
                SELECT role, content FROM claude_messages
                WHERE conversation_id = $1 AND deleted_at IS NULL
                ORDER BY created_at ASC
              `, [convId]);
              messages = rows.map(r => ({ role: r.role, content: r.content }));
            } catch { /* table may not exist on this install — non-fatal */ }
          }
        }

        // 3) Last-resort durable source: conversation_history.log_file. Keep
        // the incomplete marker explicit; a partial JSONL stream is evidence
        // of partial work, never a fabricated completed transcript.
        let logTranscript: LogTranscript | null = null;
        if (messages.length === 0 && record?.log_file) {
          logTranscript = await readLogTranscript(record.log_file);
          messages = logTranscript.messages;
        }

        if (messages.length === 0) {
          const incomplete = logTranscript?.incompleteReason
            ? ` Incomplete transcript: ${ logTranscript.incompleteReason }.`
            : '';
          return {
            successBoolean: true,
            responseString: `${ incomplete || `No stored transcript found for ${ input.threadId ? `threadId "${ input.threadId }"` : `id "${ input.id }"` }.` }${ record ? ` (Conversation "${ title }" exists but its messages are not retrievable.)` : '' }`,
          };
        }

        const transcript = buildTranscript(messages);
        const completeness = logTranscript && !logTranscript.complete
          ? ` INCOMPLETE TRANSCRIPT: ${ logTranscript.incompleteReason }.`
          : '';
        const header = `Conversation: ${ title }${ record?.last_active_at ? ` — last active ${ new Date(record.last_active_at).toLocaleString() }` : '' } (${ messages.length } messages stored)${ completeness }`;

        return {
          successBoolean: true,
          responseString: `${ header }\n\n${ transcript }`,
        };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use search, recent, get, or messages.` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `Conversation search failed: ${ (error as Error).message }` };
    }
  }
}
