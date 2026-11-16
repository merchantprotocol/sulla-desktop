// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentConversationProvider } from '../../app/Providers/AgentConversationServiceProvider';
import type { SubAgentExchangePayload } from '../../app/Services/SubAgentExchangeEmitter';

export type { SubAgentExchangePayload } from '../../app/Services/SubAgentExchangeEmitter';

/**
 * UI-only transcript event. It is never injected into the graph/model.
 * @deprecated Use agentConversationProvider.exchanges.emit().
 */
export function emitSubAgentExchange(
  parentChannel: string | undefined,
  parentThreadId: string | undefined,
  exchange: SubAgentExchangePayload,
): Promise<void> {
  return agentConversationProvider.exchanges.emit(parentChannel, parentThreadId, exchange);
}
