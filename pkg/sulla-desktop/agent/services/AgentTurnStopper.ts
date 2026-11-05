// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { getWebSocketClientService } from './WebSocketClientService';

export interface TurnStopTransport { send(channelId: string, message: { type: 'stop_run'; data: { threadId: string } }): Promise<unknown> }

export interface TurnStopper { stop(channelId: string, threadId: string): Promise<void> }

/** Silently aborts one chat turn on the channel that owns its abort key. */
export class AgentTurnStopper implements TurnStopper {
  constructor(private readonly transport: TurnStopTransport = getWebSocketClientService()) {}

  async stop(channelId: string, threadId: string): Promise<void> {
    await this.transport.send(channelId, { type: 'stop_run', data: { threadId } });
  }
}
