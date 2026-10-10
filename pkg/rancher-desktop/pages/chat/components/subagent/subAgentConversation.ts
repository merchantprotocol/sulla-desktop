export interface SubAgentConversationTarget {
  agentId:        string;
  label:          string;
  conversationId: string;
}

export type OpenSubAgentConversation = (target: SubAgentConversationTarget) => void;
