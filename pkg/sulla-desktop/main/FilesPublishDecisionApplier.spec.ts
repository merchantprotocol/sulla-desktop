// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '@pkg/shared/decisions';
import { DecisionService } from '@pkg/agent/services/DecisionService';
import { PublishApprovalCoordinator } from '@pkg/agent/tools/files/PublishApprovalCoordinator';
import { FilesPublishDecisionApplier } from './FilesPublishDecisionApplier';

class InlineApprovalFlowHarness {
  readonly records = new Map<string, DecisionRecord>();
  readonly repository = {
    insert: vi.fn(async(record: DecisionRecord) => { this.records.set(record.id, record) }),
    settle: vi.fn(async(id: string, _action: string, next: DecisionRecord) => {
      const previous = this.records.get(id);
      if (!previous || previous.status !== 'pending') return false;
      this.records.set(id, next);
      return true;
    }),
    expirePending: vi.fn(async(id: string) => {
      const previous = this.records.get(id);
      if (previous) this.records.set(id, { ...previous, status: 'expired' });
    }),
  };
  readonly pending = { ancestry: vi.fn(async() => []) };
  readonly decisions = new DecisionService(undefined, { decisions: this.repository as any, pendingDecisions: this.pending as any });
  readonly request = vi.fn(async() => ({ ok: true, status: 200 }));
  readonly errors: string[] = [];
  readonly publisher = new FilesPublishDecisionApplier(this.decisions, async() => ({ request: this.request }), message => this.errors.push(message));
  readonly coordinator = new PublishApprovalCoordinator(this.decisions);
  readonly notifications: string[] = [];

  constructor() {
    this.publisher.start();
    this.coordinator.start();
  }

  async decide(action: 'approved' | 'denied' | 'expired') {
    const { record, result } = await this.decisions.request({
      kind: 'approval', title: "Activate agent 'coding-manager' v1.0.0?", toolName: 'files_request_publish',
      conversationId: 'chat-thread', channel: 'chat-channel', payload: { filesPublishRequestId: 'request/7' },
    }, 30 * 60_000);
    this.coordinator.register(record.id, async message => { this.notifications.push(message); return true });

    if (action === 'expired') await this.decisions.expire(record.id);
    else await this.decisions.resolve({ id: record.id, conversationId: record.conversationId, action });
    await expect(result).resolves.toMatchObject({ status: action });
    await vi.waitFor(() => expect(this.request).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(this.notifications).toHaveLength(1));
    return record;
  }

  dispose(): void {
    this.publisher.dispose();
    this.coordinator.dispose();
  }
}

describe('Files publish decision flow', () => {
  // risk: irreversible side effects — only an approved DecisionService record may activate a Files draft.
  it('approving the inline decision invokes the Files publish endpoint once and publishes', async() => {
    const flow = new InlineApprovalFlowHarness();
    try {
      const record = await flow.decide('approved');
      expect(flow.request).toHaveBeenCalledWith('/v1/files/publish-requests/request%2F7/approve', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(flow.repository.settle).toHaveBeenCalledWith(record.id, 'approved', expect.objectContaining({ status: 'approved' }), expect.any(String));
      expect(flow.notifications).toEqual(['File version publish approved.']);
      expect(flow.errors).toEqual([]);
    } finally { flow.dispose() }
  });

  it('denying resolves the same decision and rejects without calling the publish endpoint', async() => {
    // risk: irreversible side effects — a denial must never reach the publish endpoint.
    const flow = new InlineApprovalFlowHarness();
    try {
      const record = await flow.decide('denied');
      expect(flow.request).toHaveBeenCalledWith('/v1/files/publish-requests/request%2F7/reject', expect.any(Object));
      expect(flow.repository.settle).toHaveBeenCalledWith(record.id, 'denied', expect.objectContaining({ status: 'denied' }), expect.any(String));
      expect(flow.request).not.toHaveBeenCalledWith(expect.stringMatching(/\/approve$/), expect.anything());
      expect(flow.notifications).toEqual(['File version publish request denied.']);
    } finally { flow.dispose() }
  });

  it('expiry rejects the Files request and surfaces an expired result', async() => {
    // risk: irreversible side effects — an expired approval must fail closed and reject the Files request.
    const flow = new InlineApprovalFlowHarness();
    try {
      const record = await flow.decide('expired');
      expect(flow.request).toHaveBeenCalledWith('/v1/files/publish-requests/request%2F7/reject', expect.any(Object));
      expect(flow.repository.expirePending).toHaveBeenCalledWith(record.id);
      expect(flow.notifications).toEqual(['File version publish request expired.']);
    } finally { flow.dispose() }
  });
});
