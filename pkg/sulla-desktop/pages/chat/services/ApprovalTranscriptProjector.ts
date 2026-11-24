// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { DecisionRecord } from '@pkg/shared/decisions';
import { asMessageId } from '../types/chat';
import type { Message, ToolApprovalMessage } from '../models/Message';

/** Adds transcript cards from the durable decision inbox when no card message survived reload. */
export class ApprovalTranscriptProjector {
  /** Cards this transcript already rebuilt stay in place once decided, so the result is shown instead of the card vanishing. */
  private readonly projected = new Set<string>();

  project(messages: readonly Message[], decisions: readonly DecisionRecord[], conversationId: string): Message[] {
    const existing = new Set(messages.flatMap(message => message.kind === 'tool_approval' && message.approvalId ? [message.approvalId] : []));
    const fallbacks = decisions.filter(record =>
      record.kind === 'approval' && record.payload?.filesPublishRequestId && (['pending', 'deferred'].includes(record.status) || this.projected.has(record.id)) &&
      (record.conversationId === conversationId || record.relatedConversationIds?.includes(conversationId)) && !existing.has(record.id),
    );
    for (const record of fallbacks) this.projected.add(record.id);
    const cards = fallbacks.map(record => ({
      id: asMessageId(`decision-approval-${ record.id }`),
      kind: 'tool_approval',
      createdAt: record.createdAt,
      title: record.title,
      reason: record.approvalPresentation?.reason ?? record.title,
      command: record.approvalPresentation?.command ?? 'Files draft publication',
      expiresAt: record.expiresAt,
      decision: 'pending',
      approvalId: record.id,
      origin: record.approvalPresentation?.origin,
      requestedBy: record.requestedBy ? { agentId: record.requestedBy.agentId, label: record.requestedBy.label } : undefined,
    } satisfies ToolApprovalMessage));
    return [...messages, ...cards];
  }
}
