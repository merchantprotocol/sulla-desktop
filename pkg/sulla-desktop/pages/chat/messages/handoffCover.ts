// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

import type { Message, SubAgentExchangeMessage } from '../models/Message';

/** The result card item for a handoff's job, if one is in the chat. */
export function resultCardFor(exchange: SubAgentExchangeMessage, messages: readonly Message[]): AgentResultItem | undefined {
  if (!exchange.jobId) return undefined;
  for (const message of messages) {
    if (message.kind !== 'proactive') continue;
    const item = message.result?.items.find(entry => entry.jobId === exchange.jobId && (entry.taskIndex ?? 0) === (exchange.taskIndex ?? 0));
    if (item) return item;
  }
  return undefined;
}

/** A "Returned from" line is not shown when a result card covers the same job: the card is the return. */
export function returnCoveredByCard(exchange: SubAgentExchangeMessage, messages: readonly Message[]): boolean {
  return exchange.direction === 'from_agent' && !!resultCardFor(exchange, messages);
}
