/**
 * Strict native allowlist for the Conversation Reader subconscious agent.
 * Read-only: DB keyword-index search plus selective log-folder drill-down.
 * No write, file, shell, or code tools — this agent only surfaces prior
 * conversation content for <conversation_context> injection; it never acts.
 */
export const CONVERSATION_READER_TOOLS: string[] = [
  'search_conversation_keywords',
  'search_conversation_logs',
];
