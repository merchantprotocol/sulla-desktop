// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolDecisionPort } from '../../tools/toolDecisionPort';
import type { DecisionRecord } from '@pkg/shared/decisions';

export interface ClerkApprovalBinding {
  identityHash: string;
  requestHash: string;
  conversationId: string;
  channel: string;
  title: string;
  showApproval?: (id: string, title: string) => Promise<unknown>;
}

export type ClerkApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'missing';

/** Reuses Desktop's durable Decide records; approval never resumes or dispatches a parked tool call. */
export class ClerkApprovalCoordinator {
  constructor(
    private readonly decisions: Pick<ToolDecisionPort, 'request' | 'findApprovalForPayload'>,
    private readonly authorize: (operationId: string) => Promise<string>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  async request(operationId: string, binding: ClerkApprovalBinding): Promise<ClerkApprovalState> {
    const existing = await this.find(operationId, binding);
    if (existing !== 'missing') return existing;
    if (!this.decisions.findApprovalForPayload) return 'missing';
    const { record } = await this.decisions.request({
      kind: 'approval', title: binding.title, conversationId: binding.conversationId,
      channel: binding.channel, toolName: 'clerk',
      payload: { clerkOperationId: operationId, callerIdentity: binding.identityHash, requestHash: binding.requestHash },
    }, this.ttlMs);
    try { await binding.showApproval?.(record.id, binding.title) } catch { /* The durable Decide inbox remains available. */ }
    return 'pending';
  }

  async retry(operationId: string, binding: ClerkApprovalBinding): Promise<{ state: ClerkApprovalState; approvalId?: string }> {
    const state = await this.find(operationId, binding);
    if (state !== 'approved') return { state };
    try {
      return { state, approvalId: await this.authorize(operationId) };
    } catch {
      return { state: 'expired' };
    }
  }

  private async find(operationId: string, binding: ClerkApprovalBinding): Promise<ClerkApprovalState> {
    const record = await this.decisions.findApprovalForPayload?.('clerkOperationId', operationId);
    if (!record || !this.matches(record, operationId, binding)) return 'missing';
    if (record.expiresAt <= this.now() || record.status === 'expired') return 'expired';
    if (record.status === 'approved') return 'approved';
    if (record.status === 'denied') return 'denied';
    if (record.status === 'pending' || record.status === 'deferred') return 'pending';
    return 'expired';
  }

  private matches(record: DecisionRecord, operationId: string, binding: ClerkApprovalBinding): boolean {
    return record.kind === 'approval' && record.toolName === 'clerk' &&
      record.conversationId === binding.conversationId && record.channel === binding.channel &&
      record.payload?.clerkOperationId === operationId &&
      record.payload.callerIdentity === binding.identityHash && record.payload.requestHash === binding.requestHash;
  }
}
