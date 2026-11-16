// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentConversationRegistry } from '../Services/AgentConversationRegistry';
import { SubAgentExchangeEmitter } from '../Services/SubAgentExchangeEmitter';
import { getWebSocketClientService } from '../../services/WebSocketClientService';

/** Binds the sub-agent conversation registry and the UI exchange emitter. */
export class AgentConversationServiceProvider {
  readonly conversations = new AgentConversationRegistry();
  // The WebSocket client is resolved per emit, exactly as before, so nothing connects at import time.
  readonly exchanges = new SubAgentExchangeEmitter(() => getWebSocketClientService(), console);
}

export const agentConversationProvider = new AgentConversationServiceProvider();
