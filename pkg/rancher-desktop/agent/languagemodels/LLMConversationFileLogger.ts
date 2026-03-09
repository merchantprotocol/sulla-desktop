/**
 * LLMConversationFileLogger — DEPRECATED / removed.
 *
 * Conversation capture is now handled entirely by TrainingDataLogger
 * which writes to ~/sulla/conversations/[sessionId].jsonl.
 *
 * This file only exports a no-op writeLLMConversationEvent so existing
 * callers (AnthropicService, OpenAICompatibleService, etc.) don't break.
 */

type LLMLogEvent = {
  direction: 'request' | 'response' | 'error';
  provider: string;
  model?: string;
  endpoint?: string;
  nodeName?: string;
  conversationId?: string;
  payload: unknown;
  attempt?: number;
};

/** No-op — conversation logging moved to TrainingDataLogger */
export function writeLLMConversationEvent(_event: LLMLogEvent): void {
  // intentionally empty
}
