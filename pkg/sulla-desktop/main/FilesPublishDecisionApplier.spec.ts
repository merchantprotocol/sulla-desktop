// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '@pkg/shared/decisions';
import { DecisionService } from '@pkg/agent/services/DecisionService';
import { DecisionExpirySweeper } from '@pkg/agent/services/DecisionExpirySweeper';
import { PublishApprovalCoordinator } from '@pkg/agent/tools/files/PublishApprovalCoordinator';
import { PublishApprovalOutcomeMessage } from '@pkg/agent/tools/files/PublishApprovalOutcomeMessage';
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
    settleDurablePublish: vi.fn(async(id: string, _action: string, next: DecisionRecord, now: number) => {
      const previous = this.records.get(id);
      if (!previous || previous.status !== 'pending' || now >= previous.expiresAt) return false;
      this.records.set(id, next);
      return true;
    }),
    expirePending: vi.fn(async(id: string) => {
      const previous = this.records.get(id);
      if (previous) this.records.set(id, { ...previous, status: 'expired' });
    }),
    listRecent: vi.fn(async() => [...this.records.values()]),
  };
  readonly pending = {
    ancestry: vi.fn(async() => []),
    findById: vi.fn(async(id: string) => this.records.get(id)),
    expireOpenDecisions: vi.fn(async() => [] as DecisionRecord[]),
  };
  readonly decisions = new DecisionService(undefined, { decisions: this.repository as any, pendingDecisions: this.pending as any });
  readonly request = vi.fn(async() => ({ ok: true, status: 200 }));
  readonly errors: string[] = [];
  readonly publisher = new FilesPublishDecisionApplier(this.decisions, async() => ({ request: this.request }), message => this.errors.push(message));
  readonly notifications: string[] = [];
  readonly wording = new PublishApprovalOutcomeMessage({ name: async() => 'Jonathon' });
  readonly coordinator = new PublishApprovalCoordinator(this.decisions, { deliver: async(_record, message) => { this.notifications.push(message); return true } }, this.wording);

  constructor() {
    this.publisher.start();
    this.coordinator.start();
  }

  async decide(action: 'approved' | 'denied' | 'expired') {
    const { record, result } = await this.decisions.request({
      kind: 'approval', title: "Activate agent 'coding-manager' v1.0.0?", toolName: 'files_request_publish',
      conversationId: 'chat-thread', channel: 'chat-channel', payload: { filesPublishRequestId: 'request/7' },
    }, 30 * 60_000);
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
      expect(flow.notifications).toEqual([`[Human decision] Jonathon approved publishing "Activate agent 'coding-manager' v1.0.0" (decision ${ record.id }).`]);
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
      expect(flow.notifications).toEqual([`[Human decision] Jonathon denied publishing "Activate agent 'coding-manager' v1.0.0" (decision ${ record.id }).`]);
    } finally { flow.dispose() }
  });

  it('expiry rejects the Files request and surfaces an expired result', async() => {
    // risk: irreversible side effects — an expired approval must fail closed and reject the Files request.
    const flow = new InlineApprovalFlowHarness();
    try {
      const record = await flow.decide('expired');
      expect(flow.request).toHaveBeenCalledWith('/v1/files/publish-requests/request%2F7/reject', expect.any(Object));
      expect(flow.repository.expirePending).toHaveBeenCalledWith(record.id);
      expect(flow.notifications).toEqual([`[Human decision] The request to publish "Activate agent 'coding-manager' v1.0.0" (decision ${ record.id }) expired: request a fresh publish if still needed.`]);
    } finally { flow.dispose() }
  });

  it('reconciles an expired persisted approval into a Files rejection and outcome message after restart', async() => {
    // risk: irreversible side effects — an approval that expired while Desktop was closed must reject the Files request and notify its asker.
    const flow = new InlineApprovalFlowHarness();
    const expired: DecisionRecord = {
      id: 'expired-after-restart', conversationId: 'child-thread', channel: 'root-channel',
      kind: 'approval', status: 'expired', title: 'Publish?', toolName: 'files_request_publish', createdAt: 100, expiresAt: 200,
      payload: { filesPublishRequestId: 'request/8' },
      requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-1', taskIndex: 0 },
    };
    flow.pending.expireOpenDecisions.mockResolvedValue([expired]);
    try {
      await flow.decisions.list();
      await vi.waitFor(() => expect(flow.request).toHaveBeenCalledWith('/v1/files/publish-requests/request%2F8/reject', expect.any(Object)));
      await vi.waitFor(() => expect(flow.notifications).toEqual([
        '[Human decision] The request to publish "Publish" (decision expired-after-restart) expired: request a fresh publish if still needed.',
      ]));
      expect(flow.pending.expireOpenDecisions).toHaveBeenCalledOnce();
    } finally { flow.dispose() }
  });

  it('expires an overdue publish approval at startup and on the next sweep with nobody opening Decide', async() => {
    // risk: irreversible side effects — after a restart nothing else times a 7-day approval, so the startup sweep must reject it in Files and tell its asker.
    const flow = new InlineApprovalFlowHarness();
    const expired = (id: string, requestId: string): DecisionRecord => ({
      id, conversationId: 'child-thread', channel: 'root-channel',
      kind: 'approval', status: 'expired', title: 'Publish?', toolName: 'files_request_publish', createdAt: 100, expiresAt: 200,
      payload: { filesPublishRequestId: requestId },
      requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-1', taskIndex: 0 },
    });
    flow.pending.expireOpenDecisions.mockResolvedValueOnce([expired('expired-while-closed', 'request/8')]);
    const ticks: (() => void)[] = [];
    const sweeper = new DecisionExpirySweeper(flow.decisions, { every: (_ms, tick) => { ticks.push(tick); return () => undefined } });
    try {
      sweeper.start();
      await vi.waitFor(() => expect(flow.request).toHaveBeenCalledWith('/v1/files/publish-requests/request%2F8/reject', expect.any(Object)));
      await vi.waitFor(() => expect(flow.notifications).toEqual([
        '[Human decision] The request to publish "Publish" (decision expired-while-closed) expired: request a fresh publish if still needed.',
      ]));

      flow.pending.expireOpenDecisions.mockResolvedValueOnce([expired('expired-while-open', 'request/9')]);
      ticks[0]();
      await vi.waitFor(() => expect(flow.request).toHaveBeenCalledWith('/v1/files/publish-requests/request%2F9/reject', expect.any(Object)));
      await vi.waitFor(() => expect(flow.notifications).toHaveLength(2));
      expect(flow.repository.listRecent).not.toHaveBeenCalled();
    } finally { sweeper.dispose(); flow.dispose() }
  });

  it('resolves and publishes from a persisted record after restart with no in-memory waiter', async() => {
    // risk: irreversible side effects — a durable publish decision cannot become unresolvable when the Desktop process restarts.
    const flow = new InlineApprovalFlowHarness();
    const { record } = await flow.decisions.request({
      kind: 'approval', title: 'Publish?', toolName: 'files_request_publish', conversationId: 'child-thread', channel: 'root-channel',
      payload: { filesPublishRequestId: 'request/7' },
      requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-1', taskIndex: 0 },
    }, 7 * 24 * 60 * 60_000);
    const restarted = new DecisionService(undefined, { decisions: flow.repository as any, pendingDecisions: flow.pending as any });
    const publisher = new FilesPublishDecisionApplier(restarted, async() => ({ request: flow.request }), message => flow.errors.push(message));
    const notifications: string[] = [];
    const coordinator = new PublishApprovalCoordinator(restarted, { deliver: async(_decision, message) => { notifications.push(message); return true } }, flow.wording);
    publisher.start();
    coordinator.start();
    try {
      await expect(restarted.resolve({ id: record.id, conversationId: 'child-thread', action: 'approved' })).resolves.toMatchObject({ settled: true });
      await vi.waitFor(() => expect(flow.request).toHaveBeenCalledTimes(1));
      expect(flow.request).toHaveBeenCalledWith('/v1/files/publish-requests/request%2F7/approve', expect.any(Object));
      expect(notifications).toEqual([`[Human decision] Jonathon approved publishing "Publish" (decision ${ record.id }).`]);
    } finally { publisher.dispose(); coordinator.dispose(); flow.dispose() }
  });

  it('applies one Files action when Decide and the inline card approve concurrently', async() => {
    // risk: irreversible side effects — simultaneous UI surfaces must never publish a draft twice.
    const flow = new InlineApprovalFlowHarness();
    try {
      const { record, result } = await flow.decisions.request({
        kind: 'approval', title: 'Publish?', toolName: 'files_request_publish', conversationId: 'chat-thread', channel: 'chat-channel',
        payload: { filesPublishRequestId: 'request/7' },
      }, 7 * 24 * 60 * 60_000);
      const receipts = await Promise.all([
        flow.decisions.resolve({ id: record.id, conversationId: record.conversationId, action: 'approved' }),
        flow.decisions.resolve({ id: record.id, conversationId: record.conversationId, action: 'approved' }),
      ]);
      await expect(result).resolves.toMatchObject({ status: 'approved' });
      await vi.waitFor(() => expect(flow.request).toHaveBeenCalledTimes(1));
      expect(receipts.filter(receipt => receipt.settled)).toHaveLength(1);
    } finally { flow.dispose() }
  });

  it('makes one Files call when the same approved decision is announced twice', async() => {
    // risk: irreversible side effects — a repeated decision event (two windows, a retry) must never publish a draft twice.
    let listener: ((record: DecisionRecord) => void) | undefined;
    const request = vi.fn(async() => ({ ok: true, status: 200 }));
    const publisher = new FilesPublishDecisionApplier(
      { subscribe: (next) => { listener = next; return () => { listener = undefined } } },
      async() => ({ request }), () => undefined,
    );
    const approved: DecisionRecord = {
      id: 'decision-twice', conversationId: 'chat-thread', channel: 'chat-channel', kind: 'approval', status: 'approved',
      title: 'Publish?', toolName: 'files_request_publish', createdAt: 100, expiresAt: 200, payload: { filesPublishRequestId: 'request/9' },
    };
    publisher.start();
    try {
      listener?.(approved);
      listener?.({ ...approved });
      await vi.waitFor(() => expect(request).toHaveBeenCalled());
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(1);
    } finally { publisher.dispose() }
  });

  it('refuses a non-human actor but keeps legacy pre-actor approvals compatible', async() => {
    // risk: irreversible side effects — a future agent answer must never publish a Files draft, while legacy human decisions still complete.
    let listener: ((record: DecisionRecord) => void) | undefined;
    const request = vi.fn(async() => ({ ok: true, status: 200 }));
    const publisher = new FilesPublishDecisionApplier(
      { subscribe: (next) => { listener = next; return () => { listener = undefined } } },
      async() => ({ request }), () => undefined,
    );
    const decision = (id: string): DecisionRecord => ({
      id, conversationId: 'chat-thread', channel: 'chat-channel', kind: 'approval', status: 'approved',
      title: 'Publish?', toolName: 'files_request_publish', createdAt: 100, expiresAt: 200,
      payload: { filesPublishRequestId: id },
    });
    publisher.start();
    try {
      listener?.({ ...decision('agent-approval'), answeredBy: { kind: 'agent', agentId: 'codex-worker' } });
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
      listener?.(decision('legacy-human-approval'));
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(request).toHaveBeenCalledWith('/v1/files/publish-requests/legacy-human-approval/approve', expect.any(Object));
    } finally { publisher.dispose() }
  });
});
