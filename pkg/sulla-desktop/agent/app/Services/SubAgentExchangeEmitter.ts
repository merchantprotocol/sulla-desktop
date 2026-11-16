// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

/** The slice of the WebSocket client the emitter needs. */
export interface SubAgentExchangeTransport {
  send(channel: string, message: unknown): Promise<unknown> | unknown;
}

export interface SubAgentExchangeLogger {
  warn(...args: unknown[]): void;
}

/** Sends UI-only sub-agent transcript events. They are never injected into the graph/model. */
export class SubAgentExchangeEmitter {
  constructor(
    private readonly transport: () => SubAgentExchangeTransport,
    private readonly logger: SubAgentExchangeLogger = console,
  ) {}

  async emit(parentChannel: string | undefined, parentThreadId: string | undefined, exchange: SubAgentExchangePayload): Promise<void> {
    if (!parentChannel || !parentThreadId) return;
    try {
      await this.transport().send(parentChannel, {
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
      this.logger.warn('[subAgentExchange] emit failed:', err);
    }
  }
}
