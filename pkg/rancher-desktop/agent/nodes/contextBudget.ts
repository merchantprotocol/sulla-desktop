import type { ChatMessage, ContentBlock } from '../languagemodels/BaseLanguageModel';

export const PROVIDER_RESPONSE_RESERVE = 0.2;
export const TOOL_RESULT_COMPACT_LIMIT = 2_000;
export const TOOL_RESULT_HEAD_CHARS = 700;
export const TOOL_RESULT_TAIL_CHARS = 500;

const CHARS_PER_TOKEN = 4;

export function estimateMessageTokens(message: ChatMessage): number {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return Math.ceil((content?.length ?? 0) / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function isToolUse(message: ChatMessage): boolean {
  return message.role === 'assistant' && Array.isArray(message.content) &&
    message.content.some((block: any) => block?.type === 'tool_use');
}

function isToolResult(message: ChatMessage): boolean {
  return message.role === 'tool' || (message.role === 'user' && Array.isArray(message.content) &&
    message.content.some((block: any) => block?.type === 'tool_result'));
}

function compactText(text: string): string {
  if (text.length <= TOOL_RESULT_COMPACT_LIMIT) return text;
  const omitted = text.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
  return `${ text.slice(0, TOOL_RESULT_HEAD_CHARS) }\n[tool result compacted: ${ omitted } chars omitted]\n${ text.slice(-TOOL_RESULT_TAIL_CHARS) }`;
}

function compactBlock(block: ContentBlock): ContentBlock {
  if (block.type !== 'tool_result') return block;
  if (typeof block.content === 'string') return { ...block, content: compactText(block.content) };
  return {
    ...block,
    content: block.content.map(child => child.type === 'text' ? { ...child, text: compactText(child.text) } : child),
  };
}

function compactToolResults(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (!isToolResult(message)) return message;
    if (typeof message.content === 'string') return { ...message, content: compactText(message.content) };
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(compactBlock) };
  });
}

function buildUnits(messages: ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    if (isToolUse(current) && next && isToolResult(next)) {
      units.push([current, next]);
      i++;
    } else if (isToolResult(current) && units.length > 0 && units[units.length - 1].length === 1 && isToolUse(units[units.length - 1][0])) {
      units[units.length - 1].push(current);
    } else {
      units.push([current]);
    }
  }
  return units;
}

/**
 * Curates the exact array sent to a provider. The budget is applied after the
 * caller's system prompt has been added, and tool use/result messages are
 * treated as indivisible units so providers never see a broken transcript.
 */
export function prepareProviderMessages(messages: ChatMessage[], contextWindow: number): {
  messages: ChatMessage[];
  inputBudgetTokens: number;
  beforeTokens: number;
  afterTokens: number;
  beforeChars: number;
  afterChars: number;
  toolResultChars: number;
} {
  const beforeTokens = estimateMessagesTokens(messages);
  const beforeChars = messages.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0);
  const compacted = compactToolResults(messages);
  const inputBudgetTokens = Math.max(1, Math.floor(contextWindow * (1 - PROVIDER_RESPONSE_RESERVE)));
  const units = buildUnits(compacted);
  const latestUserUnit = [...units].reverse().find(unit => unit.some(message => message.role === 'user'));
  const protectedUnits = new Set(latestUserUnit ? [latestUserUnit] : []);
  const kept: Array<{ index: number; unit: ChatMessage[] }> = [];
  let used = 0;

  // System prompt and the current user turn are mandatory. Recent transcript
  // units are retained next; old units are evicted as whole tool pairs.
  for (const unit of units) {
    if (unit.some(message => message.role === 'system')) {
      kept.push({ index: units.indexOf(unit), unit });
      used += unit.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    }
  }
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    if (unit.some(message => message.role === 'system') || protectedUnits.has(unit)) continue;
    const unitTokens = unit.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (used + unitTokens <= inputBudgetTokens) {
      kept.push({ index: i, unit });
      used += unitTokens;
    }
  }
  for (const unit of protectedUnits) {
    if (!kept.some(entry => entry.unit === unit)) kept.push({ index: units.indexOf(unit), unit });
  }

  const result = kept.sort((a, b) => a.index - b.index).flatMap(entry => entry.unit);
  const afterChars = result.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0);
  const toolResultChars = result.reduce((sum, message) => {
    if (!isToolResult(message)) return sum;
    return sum + JSON.stringify(message.content).length;
  }, 0);
  return {
    messages: result,
    inputBudgetTokens,
    beforeTokens,
    afterTokens: estimateMessagesTokens(result),
    beforeChars,
    afterChars,
    toolResultChars,
  };
}
