// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../tools/files/common', () => ({
  FilesTool: class {
    state: any = { metadata: {} };
    executionContext: any;
    sentMessages: Array<{ content: string; kind: string; extras?: Record<string, unknown> }> = [];
    delivery = true;
    context() { return this.executionContext ?? { thread_id: this.state?.metadata?.threadId } }
    emitMessage = async(content: string, kind = 'progress', extras?: Record<string, unknown>) => {
      this.sentMessages.push({ content, kind, extras });
      return this.delivery;
    };
  },
}));
vi.mock('../../../tools/toolRuntime', () => ({ toolRuntime: { publishApprovalCoordinator: { start: () => undefined } } }));
vi.mock('../../../database/models/AgentJobMessagingModel', () => ({ AgentJobMessagingModel: { taskForThread: vi.fn() } }));
vi.mock('../../../services/DecisionService', async(importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/DecisionService')>();
  return { ...actual, decisionService: {} };
});

import { DecisionService } from '../../../services/DecisionService';
import { FilesRequestPublishWorker } from '../../../tools/files/request_publish';
import { PublishApprovalCoordinator } from '../../../tools/files/PublishApprovalCoordinator';
import { PublishApprovalOutcomeMessage } from '../../../tools/files/PublishApprovalOutcomeMessage';
import { PublishApprovalRouter } from '../../../tools/files/PublishApprovalRouter';

const wording = new PublishApprovalOutcomeMessage({ name: async() => 'Jonathon' });

class DecisionServiceFixture {
  readonly records = new Map<string, any>();
  readonly repository = {
    insert: vi.fn(async(record: any) => { this.records.set(record.id, record) }),
    settle: vi.fn(async(id: string, _action: string, next: any) => {
      const previous = this.records.get(id);
      if (!previous || previous.status !== 'pending') return false;
      this.records.set(id, next);
      return true;
    }),
    expirePending: vi.fn(async(id: string) => {
      const previous = this.records.get(id);
      if (!previous || !['pending', 'deferred'].includes(previous.status)) return undefined;
      const expired = { ...previous, status: 'expired' };
      this.records.set(id, expired);
      return expired;
    }),
  };
  readonly pendingRepository = {
    ancestry: vi.fn(async() => []),
    findApproval: vi.fn(async(_session: string, key: string, value: string) => [...this.records.values()].find(record => record.kind === 'approval' && record.payload?.[key] === value && record.expiresAt > Date.now())),
  };
  readonly service = new DecisionService(undefined, { decisions: this.repository as any, pendingDecisions: this.pendingRepository as any });
}

class PublishWorkerHarness extends FilesRequestPublishWorker {
  posted = 0;

  constructor(
    coordinator: any,
    decisions: any,
    metadata: Record<string, unknown> = { threadId: 'chat-thread', wsChannel: 'chat-channel' },
    resolver = new PublishApprovalRouter({ taskForThread: async() => null }),
    readonly rootCards = { send: vi.fn(async(_target: { channel: string; threadId: string }, _card: Record<string, unknown>) => true) },
  ) {
    super(coordinator, decisions, resolver, rootCards);
    (this as any).state = { metadata };
  }

  protected override async containerJson<T>(path: string): Promise<T> {
    if (path.includes('publish-request')) {
      this.posted += 1;
      return { id: 'files-request-7' } as T;
    }
    return { file: { path: 'Use Cases/agents/coding-manager/manifest.yaml' }, content_base64: '' } as T;
  }

  async execute(input: unknown) { return this._validatedCall(input) }
}

describe('Files request publish inline approval', () => {
  it('emits a tool approval card bound to the exact DecisionService id and expiry', async() => {
    // risk: irreversible side effects — the visible card must resolve the same durable approval that gates publication.
    const fixture = new DecisionServiceFixture();
    const coordinator = new PublishApprovalCoordinator(fixture.service, { deliver: async() => true }, wording);
    const worker = new PublishWorkerHarness(coordinator, fixture.service);
    try {
      const result = await worker.execute({ file_id: 'file-7', version_id: 'version-7' });
      const decision = JSON.parse(result.responseString);
      const record = fixture.records.get(decision.decision_id);

      expect(decision).toMatchObject({ request_id: 'files-request-7', status: 'pending' });
      expect(record).toMatchObject({ id: decision.decision_id, kind: 'approval', status: 'pending', conversationId: 'chat-thread', payload: { filesPublishRequestId: 'files-request-7' } });
      expect(record.route).toMatchObject({ authority: 'human', holderIndex: 0, chain: [{ kind: 'human' }] });
      expect(record.expiresAt - record.createdAt).toBe(7 * 24 * 60 * 60_000);
      expect(record.approvalPresentation).toMatchObject({ reason: 'Publishing this draft will make it available to agents.', command: 'Files draft publication', origin: { kind: 'files_publish' } });
      expect((worker as any).sentMessages).toHaveLength(1);
      expect((worker as any).sentMessages[0]).toMatchObject({
        content: '',
        kind: 'tool_approval',
        extras: { toolApproval: { approvalId: decision.decision_id, title: record.title, expiresAt: record.expiresAt, origin: { kind: 'files_publish' } } },
      });
      const final = await fixture.service.resolve({ id: record.id, conversationId: record.conversationId, action: 'approved' }, { kind: 'human' });
      expect(final.settled).toBe(true);
    } finally { coordinator.dispose() }
  });

  it('emits a child approval into its root chat and records who requested it', async() => {
    // risk: approval routing — hidden child threads have no human tab, so consent must reach the ancestry root with durable requester identity.
    const fixture = new DecisionServiceFixture();
    fixture.pendingRepository.ancestry.mockResolvedValue(['child-thread', 'root-thread']);
    const job = {
      jobId: 'job-child', taskIndex: 2, jobStatus: 'running', taskStatus: 'running', threadId: 'child-thread',
      parentThreadId: 'root-thread', parentChannel: 'root-channel', agentId: 'codex-luna-worker', label: 'Publish the agent',
    };
    const resolver = new PublishApprovalRouter({ taskForThread: async(threadId) => threadId === 'child-thread' ? job : null });
    const coordinator = new PublishApprovalCoordinator(fixture.service, { deliver: async() => true }, wording);
    const worker = new PublishWorkerHarness(coordinator, fixture.service, { threadId: 'child-thread', wsChannel: 'child-channel' }, resolver);
    try {
      const result = await worker.execute({ file_id: 'file-7', version_id: 'version-7' });
      const record = fixture.records.get(JSON.parse(result.responseString).decision_id);
      expect(record).toMatchObject({
        conversationId: 'child-thread', relatedConversationIds: ['child-thread', 'root-thread'],
        requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-child', taskIndex: 2 },
      });
      expect(worker.rootCards.send).toHaveBeenCalledWith({ channel: 'root-channel', threadId: 'root-thread' }, expect.objectContaining({ approvalId: record.id, origin: { kind: 'files_publish' } }));
      expect((worker as any).sentMessages ?? []).toHaveLength(0);
    } finally { coordinator.dispose() }
  });

  it('records the requesting task even when the job was launched with the default agent', async() => {
    // risk: agent continuity — a task with no agent id must keep its job mailbox route, or its outcome goes to a hidden thread nobody reads.
    const fixture = new DecisionServiceFixture();
    const job = {
      jobId: 'job-default', taskIndex: 1, jobStatus: 'running', taskStatus: 'running', threadId: 'child-thread',
      parentThreadId: 'root-thread', parentChannel: 'root-channel',
    };
    const coordinator = new PublishApprovalCoordinator(fixture.service, { deliver: async() => true }, wording);
    const worker = (label?: string) => new PublishWorkerHarness(coordinator, fixture.service, { threadId: 'child-thread', wsChannel: 'child-channel' },
      new PublishApprovalRouter({ taskForThread: async(threadId) => threadId === 'child-thread' ? { ...job, label } : null }));
    try {
      const labelled = fixture.records.get(JSON.parse((await worker('Publish the agent').execute({ file_id: 'file-7', version_id: 'version-7' })).responseString).decision_id);
      expect(labelled.requestedBy).toEqual({ label: 'Publish the agent', jobId: 'job-default', taskIndex: 1 });

      fixture.records.clear();
      const unnamed = fixture.records.get(JSON.parse((await worker().execute({ file_id: 'file-7', version_id: 'version-7' })).responseString).decision_id);
      expect(unnamed.requestedBy).toEqual({ jobId: 'job-default', taskIndex: 1 });
    } finally { coordinator.dispose() }
  });

  it('does not report a request as delivered when the chat transport rejects the card', async() => {
    // risk: approval routing — a publish request must not look actionable in chat when its card was dropped.
    const fixture = new DecisionServiceFixture();
    const coordinator = new PublishApprovalCoordinator(fixture.service, { deliver: async() => true }, wording);
    const worker = new PublishWorkerHarness(coordinator, fixture.service);
    (worker as any).delivery = false;

    try {
      await expect(worker.execute({ file_id: 'file-7', version_id: 'version-7' })).rejects.toThrow(/inline approval card could not be delivered/i);
      expect(fixture.records.size).toBe(1);
    } finally { coordinator.dispose() }
  });

  it('re-emits the same pending approval card on a retry without creating a second decision', async() => {
    // risk: approval routing — a retried CLI call can recover a dropped card without duplicating consent records.
    const record = {
      id: 'decision-10', conversationId: 'chat-thread', channel: 'chat-channel', kind: 'approval', status: 'pending',
      title: 'Activate skill gate-test v2.0.0?', createdAt: Date.now(), expiresAt: Date.now() + 30 * 60_000,
      payload: { filesPublishRequestId: 'files-request-7' },
    };
    const fixture = new DecisionServiceFixture();
    fixture.records.set(record.id, record);
    const coordinator = new PublishApprovalCoordinator(fixture.service, { deliver: async() => true }, wording);
    const worker = new PublishWorkerHarness(coordinator, fixture.service);

    try {
      const result = await worker.execute({ file_id: 'file-7', version_id: 'version-7' });
      expect(JSON.parse(result.responseString)).toMatchObject({ decision_id: 'decision-10', status: 'pending' });
      expect(fixture.repository.insert).not.toHaveBeenCalled();
      expect((worker as any).sentMessages[0]).toMatchObject({
        kind: 'tool_approval', extras: { toolApproval: { approvalId: 'decision-10', title: record.title, expiresAt: record.expiresAt } },
      });
    } finally { coordinator.dispose() }
  });

  it('refuses a mismatched CLI thread before creating a publish request', async() => {
    // risk: tenant isolation — a valid decision must never be displayed or approved from another thread.
    const worker = new PublishWorkerHarness({ start: vi.fn() }, {}, { threadId: 'unrelated-thread', wsChannel: 'other-channel' });
    (worker as any).executionContext = { thread_id: 'verified-thread' };

    await expect(worker.execute({ file_id: 'file-7', version_id: 'version-7' })).rejects.toThrow(/does not match the original conversation/i);
    expect(worker.posted).toBe(0);
  });
});
