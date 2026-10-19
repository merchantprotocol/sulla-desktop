/**
 * Per-spawn system prompt files for the CLI providers (Claude Code, Codex).
 *
 * ProviderExecutionTransport stages the caller-built system prompt directly
 * into guest-owned storage. Claude Code reads it through
 * --append-system-prompt-file; Codex uses model_instructions_file.
 */

import type { ChatMessage } from './BaseLanguageModel';

/** Concatenated text of every system-role message — the caller-built system prompt. */
export function systemPromptFromMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'system') continue;
    const c: any = m.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
        : '';
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join('\n\n');
}
