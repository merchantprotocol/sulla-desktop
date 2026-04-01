/**
 * ConversationTitleService — lightweight auto-titling for conversation history.
 *
 * Generates a short (<=6 word) title for a conversation based on its first
 * few messages. Uses the active LLM service when available, falling back
 * to a simple heuristic (first user message truncated to 50 chars).
 *
 * Usage:
 *   import { generateTitle, autoTitleAfterMessages } from './ConversationTitleService';
 *
 *   const title = await generateTitle(messages);
 *   // Or hook into message flow:
 *   autoTitleAfterMessages(conversationId, messages);
 */

import { ConversationHistoryModel } from '../database/models/ConversationHistoryModel';

/** Minimal message shape — compatible with both ChatMessage and simpler objects. */
export interface TitleMessage {
  role:    string;
  content: string;
}

/** Number of messages after which auto-title is triggered. */
const AUTO_TITLE_THRESHOLD = 3;

/** Track which conversations have already been auto-titled. */
const titledConversations = new Set<string>();

/**
 * Generate a short title (<=6 words) from the first few messages of a conversation.
 *
 * Attempts to call the active LLM for a summary. Falls back to extracting
 * the first user message and truncating it.
 */
export async function generateTitle(messages: TitleMessage[]): Promise<string> {
  // Extract meaningful messages (skip system, limit to first 5)
  const relevantMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(0, 5);

  if (relevantMessages.length === 0) {
    return 'Untitled Conversation';
  }

  // Try LLM-based title generation
  try {
    const { getPrimaryService } = await import('../languagemodels/index');
    const llm = await getPrimaryService();

    if (llm) {
      const prompt = relevantMessages
        .map(m => `${ m.role }: ${ typeof m.content === 'string' ? m.content.slice(0, 300) : String(m.content).slice(0, 300) }`)
        .join('\n');

      const response = await llm.chat([
        {
          role:    'system',
          content: 'Summarize the following conversation in 6 words or fewer. Return ONLY the title, no quotes, no punctuation at the end.',
        },
        {
          role:    'user',
          content: prompt,
        },
      ], {
        maxTokens:   30,
        temperature: 0.3,
      });

      if (response?.content) {
        const title = response.content.trim().replace(/[."]+$/g, '');

        if (title.length > 0 && title.length <= 80) {
          return title;
        }
      }
    }
  } catch {
    // LLM unavailable — fall through to heuristic
  }

  // Heuristic fallback: first user message, truncated
  return heuristicTitle(relevantMessages);
}

/**
 * Simple heuristic: take the first user message and truncate to 50 chars.
 */
function heuristicTitle(messages: TitleMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');

  if (!firstUser) {
    return 'Untitled Conversation';
  }

  const content = typeof firstUser.content === 'string'
    ? firstUser.content
    : String(firstUser.content);

  // Clean up: remove newlines, collapse whitespace
  const cleaned = content.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

  if (cleaned.length <= 50) {
    return cleaned;
  }

  // Truncate at word boundary
  const truncated = cleaned.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(' ');

  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/**
 * Auto-title a conversation after it reaches the message threshold.
 * Call this after each message event. It will fire once per conversation
 * after the third message.
 *
 * @param conversationId - The conversation record ID
 * @param messages       - All messages so far in the conversation
 */
export async function autoTitleAfterMessages(
  conversationId: string,
  messages: TitleMessage[],
): Promise<void> {
  // Only trigger once per conversation, after reaching the threshold
  if (titledConversations.has(conversationId)) return;
  if (messages.length < AUTO_TITLE_THRESHOLD) return;

  titledConversations.add(conversationId);

  try {
    const title = await generateTitle(messages);

    await ConversationHistoryModel.updateTitle(conversationId, title);
  } catch (err) {
    globalThis.console.error('[ConversationTitleService] Failed to auto-title:', err);
  }
}

/**
 * Clear the tracking set for a conversation (e.g. when it's restarted).
 */
export function resetTitleTracking(conversationId: string): void {
  titledConversations.delete(conversationId);
}
