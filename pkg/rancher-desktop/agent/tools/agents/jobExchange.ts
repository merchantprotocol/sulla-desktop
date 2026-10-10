import { getWebSocketClientService } from '../../services/WebSocketClientService';

export interface SubAgentExchangePayload {
  direction:       'to_agent' | 'from_agent';
  agentId:         string;
  label:           string;
  summary:         string;
  detail:          string;
  status:          'running' | 'done' | 'failed' | 'stopped';
  jobId?:          string;
  taskIndex?:      number;
  conversationId?: string;
  native?:         boolean;
}

/** UI-only transcript event. It is never injected into the graph/model. */
export async function emitSubAgentExchange(
  parentChannel: string | undefined,
  parentThreadId: string | undefined,
  exchange: SubAgentExchangePayload,
): Promise<void> {
  if (!parentChannel || !parentThreadId) return;
  try {
    await getWebSocketClientService().send(parentChannel, {
      type: 'chat_message',
      data: {
        kind:             'sub_agent_exchange',
        role:             'assistant',
        content:          exchange.summary,
        threadId:         parentThreadId,
        subAgentExchange: exchange,
      },
    });
  } catch (err) {
    console.warn('[subAgentExchange] emit failed:', err);
  }
}
