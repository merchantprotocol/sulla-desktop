// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// agentConversationLog.ts — Read an agent conversation's message log for the
// Agents tab.
//
// conversation_history (Postgres) is the index of every agent conversation:
// who ran it, when, its thread id, and `log_file`. The message bodies live in
// that JSONL file, written by SullaLogger (one event per line). This module
// turns those lines into display entries. It has no Electron imports so it
// can be unit tested directly.

import fs from 'fs';
import path from 'path';

export interface AgentConversationEntry {
  kind:      'user' | 'assistant' | 'tool' | 'event';
  ts:        string;
  text:      string;
  toolName?: string;
  /** Byte offset of this entry's JSONL line in the source log. */
  offset?:   number;
}

export interface AgentConversationLogIdentity {
  size:        number;
  ino:         number;
  birthtimeMs: number;
}

export interface AgentConversationLog {
  entries:      AgentConversationEntry[];
  logIdentity?: AgentConversationLogIdentity;
  /** True when older entries were dropped to stay under the read caps. */
  truncated:  boolean;
  /** True when the index row has no readable log file. */
  missingLog: boolean;
}

/** Read at most this many bytes from the end of a log file. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** Return at most this many (most recent) entries. */
export const MAX_ENTRIES = 1000;

const MAX_TOOL_ARGS_CHARS = 2000;
const PREVIEW_HEAD_BYTES = 32 * 1024;
const PREVIEW_CHARS = 200;

/**
 * True when `file` resolves inside `logsDir`. log_file comes from the DB, so
 * never read a path outside the Sulla logs directory.
 */
export function isInsideLogsDir(file: string, logsDir: string): boolean {
  const resolved = path.resolve(file);
  const root = path.resolve(logsDir);

  return resolved.startsWith(root + path.sep);
}

function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  let text: string;

  try {
    text = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  } catch {
    text = String(args);
  }

  return text.length > MAX_TOOL_ARGS_CHARS ? `${ text.slice(0, MAX_TOOL_ARGS_CHARS) }…` : text;
}

/** Map one parsed JSONL event to a display entry, or null for noise. */
export function toEntry(event: any, offset?: number): AgentConversationEntry | null {
  if (!event || typeof event !== 'object') return null;
  const ts = String(event.ts ?? '');
  const sourceIdentity = offset === undefined ? {} : { offset };

  switch (event.type) {
  case 'message':
    if (event.role === 'user' || event.role === 'assistant') {
      return { kind: event.role, ts, text: String(event.content ?? ''), ...sourceIdentity };
    }
    if (event.role === 'system') {
      return { kind: 'event', ts, text: String(event.content ?? ''), ...sourceIdentity };
    }

    return null;
  case 'tool_call':
    return {
      kind:     'tool',
      ts,
      toolName: String(event.toolName ?? 'tool'),
      text:     stringifyArgs(event.args),
      ...sourceIdentity,
    };
  case 'graph_started':
    return { kind: 'event', ts, text: `Started${ event.agentName ? ` — ${ event.agentName }` : '' }`, ...sourceIdentity };
  case 'graph_completed':
    return { kind: 'event', ts, text: `Finished${ event.status ? ` — ${ event.status }` : '' }`, ...sourceIdentity };
  case 'workflow_started':
    return { kind: 'event', ts, text: `Workflow started${ event.workflowName ? ` — ${ event.workflowName }` : '' }`, ...sourceIdentity };
  case 'workflow_completed':
    return { kind: 'event', ts, text: `Workflow finished${ event.status ? ` — ${ event.status }` : '' }${ event.error ? ` (${ event.error })` : '' }`, ...sourceIdentity };
  default:
    // Streaming markers, node bookkeeping, etc. — not conversation content.
    return null;
  }
}

/** Parse JSONL text into entries. Malformed lines are skipped. */
export class ConversationLogParser {
  parse(buffer: Buffer, sourceOffset = 0, maxEntries = MAX_ENTRIES): { entries: AgentConversationEntry[]; truncated: boolean } {
    const entries: AgentConversationEntry[] = [];
    let lineStart = 0;

    while (lineStart < buffer.length) {
      const newline = buffer.indexOf(0x0A, lineStart);
      const lineEnd = newline < 0 ? buffer.length : newline;
      const line = buffer.toString('utf-8', lineStart, lineEnd);

      if (line.trim()) {
        try {
          const entry = toEntry(JSON.parse(line), sourceOffset + lineStart);

          if (entry) entries.push(entry);
        } catch {
          // Malformed lines are skipped without changing later source offsets.
        }
      }
      if (newline < 0) break;
      lineStart = newline + 1;
    }

    return entries.length > maxEntries ? { entries: entries.slice(-maxEntries), truncated: true } : { entries, truncated: false };
  }
}

export function parseConversationLog(text: string, maxEntries = MAX_ENTRIES): { entries: AgentConversationEntry[]; truncated: boolean } {
  return new ConversationLogParser().parse(Buffer.from(text), 0, maxEntries);
}

/** Read and parse a conversation's JSONL log, tail-capped at MAX_LOG_BYTES. */
export async function readConversationLog(file: string | null | undefined, logsDir: string): Promise<AgentConversationLog> {
  if (!file || !isInsideLogsDir(file, logsDir)) {
    return { entries: [], truncated: false, missingLog: true };
  }

  let handle: fs.promises.FileHandle | undefined;

  try {
    handle = await fs.promises.open(file, 'r');
    const { size, ino, birthtimeMs } = await handle.stat();
    const start = Math.max(0, size - MAX_LOG_BYTES);
    const buffer = Buffer.alloc(size - start);

    await handle.read(buffer, 0, buffer.length, start);
    let completeLines = buffer;
    let sourceOffset = start;

    // A mid-file start lands inside a line — drop that partial line while
    // retaining the absolute byte offset of every complete JSONL record.
    if (start > 0) {
      const firstNewline = buffer.indexOf(0x0A);

      completeLines = firstNewline < 0 ? Buffer.alloc(0) : buffer.subarray(firstNewline + 1);
      sourceOffset += firstNewline < 0 ? buffer.length : firstNewline + 1;
    }

    const parsed = new ConversationLogParser().parse(completeLines, sourceOffset);

    return {
      ...parsed,
      truncated: parsed.truncated || start > 0,
      missingLog: false,
      logIdentity: { size, ino, birthtimeMs },
    };
  } catch {
    return { entries: [], truncated: false, missingLog: true };
  } finally {
    await handle?.close();
  }
}

/** First user message of a conversation, shortened — used as a list preview. */
export async function readConversationPreview(file: string | null | undefined, logsDir: string): Promise<string> {
  if (!file || !isInsideLogsDir(file, logsDir)) return '';

  let handle: fs.promises.FileHandle | undefined;

  try {
    handle = await fs.promises.open(file, 'r');
    const buffer = Buffer.alloc(PREVIEW_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PREVIEW_HEAD_BYTES, 0);
    const lines = buffer.toString('utf-8', 0, bytesRead).split('\n');

    for (const line of lines) {
      if (!line.includes('"role":"user"')) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === 'message' && event.role === 'user') {
          const text = String(event.content ?? '').replace(/\s+/g, ' ').trim();

          return text.length > PREVIEW_CHARS ? `${ text.slice(0, PREVIEW_CHARS) }…` : text;
        }
      } catch {
        // The first user message may be longer than the head we read.
      }
    }
  } catch {
    // Missing or unreadable file — no preview.
  } finally {
    await handle?.close();
  }

  return '';
}
