import type { Message, ThinkingMessage, ToolMessage } from '../../models/Message';

export interface TranscriptThinkingGroup {
  id:       string;
  kind:     'thinking-group';
  messages: readonly (ThinkingMessage | ToolMessage)[];
}

export type TranscriptEntry = Message | TranscriptThinkingGroup;

/**
 * Coalesce adjacent thinking and tool messages into one thinking bubble.
 * Approval and question messages are deliberately not included, so they stay
 * visible and actionable outside the collapsible work log.
 */
export function groupTranscriptThinking(messages: readonly Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (let index = 0; index < messages.length;) {
    const message = messages[index];

    if (message.kind !== 'thinking' && message.kind !== 'tool') {
      entries.push(message);
      index++;
      continue;
    }

    const work: (ThinkingMessage | ToolMessage)[] = [message];
    let cursor = index + 1;
    let groupTurnId = message.turnId;

    while (cursor < messages.length) {
      const candidate = messages[cursor];

      if (candidate.kind !== 'thinking' && candidate.kind !== 'tool') break;
      if (groupTurnId && candidate.turnId && candidate.turnId !== groupTurnId) break;
      groupTurnId ??= candidate.turnId;
      work.push(candidate);
      cursor++;
    }

    entries.push({
      id:       `thinking-group:${ message.id }`,
      kind:     'thinking-group',
      messages: work,
    });
    index = cursor;
  }

  return entries;
}
