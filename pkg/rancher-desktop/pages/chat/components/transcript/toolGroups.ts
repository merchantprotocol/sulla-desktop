import type { Message, ToolMessage } from '../../models/Message';

export interface TranscriptToolGroup {
  id:       string;
  kind:     'tool-group';
  messages: readonly ToolMessage[];
}

export type TranscriptEntry = Message | TranscriptToolGroup;

/**
 * Coalesce adjacent tool calls from the same logical turn. Messages without a
 * turn id are grouped only while they remain adjacent, preserving transcript
 * order and never pulling calls across another message.
 */
export function groupTranscriptTools(messages: readonly Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (let index = 0; index < messages.length;) {
    const message = messages[index];

    if (message.kind !== 'tool') {
      entries.push(message);
      index++;
      continue;
    }

    const calls: ToolMessage[] = [message];
    let cursor = index + 1;

    while (cursor < messages.length) {
      const candidate = messages[cursor];

      if (candidate.kind !== 'tool' || candidate.turnId !== message.turnId) break;
      calls.push(candidate);
      cursor++;
    }

    entries.push({
      id:       `tool-group:${ message.id }`,
      kind:     'tool-group',
      messages: calls,
    });
    index = cursor;
  }

  return entries;
}
