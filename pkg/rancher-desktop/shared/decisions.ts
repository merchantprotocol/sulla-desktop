export interface DecisionRecord {
  id:             string;
  conversationId: string;
  channel:        string;
  title:          string;
  kind:           'approval' | 'question';
  status:         'pending' | 'deferred' | 'approved' | 'denied' | 'answered' | 'expired';
  createdAt:      number;
  expiresAt:      number;
  toolName?:      string;
  questions?:     { question: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[];
}
export interface DecisionResponse {
  id:             string;
  conversationId: string;
  action:         'approved' | 'denied' | 'answered' | 'deferred';
  answers?:       { question: string; selected: string[] }[];
}
export interface DecisionOutcome {
  status:  DecisionRecord['status'];
  answers: { question: string; selected: string[] }[];
}
