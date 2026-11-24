// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BaseThreadState } from '../nodes/Graph';

export interface ChatMessageBus {
  send(connectionId: string, message: unknown): Promise<boolean>;
}

interface ChatCapableTool {
  name?: string;
  metadata?: { category?: unknown };
  sendChatMessage?: (content: string, kind?: string, extras?: Record<string, unknown>) => Promise<boolean>;
}

/**
 * Chat transport for tools invoked outside the in-process ToolExecutor: the
 * `sulla` CLI over a verified tool-session token, and the MCP sulla_tool.
 * The state passed in is always the live graph state bound server-side to the
 * session token, so messages go to that graph's own thread and channel exactly
 * as BaseNode.wsChatMessage would send them. Only allow-listed tools get it,
 * so other CLI tools keep their current (silent) behavior.
 */
export class ToolSessionChatTransport {
  private static readonly SUPPORTED = new Set(['files/open', 'files/files_open']);

  constructor(private readonly bus: () => Promise<ChatMessageBus> = ToolSessionChatTransport.defaultBus) {}

  supports(tool: ChatCapableTool): boolean {
    return ToolSessionChatTransport.SUPPORTED.has(`${ String(tool.metadata?.category ?? '') }/${ String(tool.name ?? '') }`);
  }

  /** Give a supported tool a transport bound to the session's graph state; never replaces an existing one. */
  attach(tool: ChatCapableTool, state: BaseThreadState | undefined): void {
    if (!state || !this.supports(tool) || typeof tool.sendChatMessage === 'function') return;
    tool.sendChatMessage = (content, kind = 'progress', extras) => this.send(state, content, kind, extras);
  }

  private async send(state: BaseThreadState, content: string, kind: string, extras?: Record<string, unknown>): Promise<boolean> {
    const metadata = state.metadata as Record<string, any>;
    const threadId = typeof metadata.threadId === 'string' ? metadata.threadId : '';
    const channel = typeof metadata.wsChannel === 'string' ? metadata.wsChannel : '';
    if (!threadId || !channel || metadata._muteWsChat || metadata.subconsciousSilent) return false;
    const bus = await this.bus();
    return bus.send(channel, {
      type: 'assistant_message',
      data: {
        content,
        role:        'assistant',
        kind,
        thread_id:   threadId,
        timestamp:   Date.now(),
        modelStatus: metadata.resolvedModelStatus,
        ...(extras ?? {}),
      },
    });
  }

  private static async defaultBus(): Promise<ChatMessageBus> {
    const { getWebSocketClientService } = await import('../services/WebSocketClientService');
    return getWebSocketClientService();
  }
}
