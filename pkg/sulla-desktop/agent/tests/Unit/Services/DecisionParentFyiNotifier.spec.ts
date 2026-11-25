// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletionFormatter } from '../../../app/Services/CompletionFormatter';
import { AgentCompletionInboxService } from '../../../app/Services/AgentCompletionInboxService';
import { CompletionIdleDispatcher } from '../../../app/Services/CompletionIdleDispatcher';
import { DecisionService } from '../../../services/DecisionService';
import { DecisionParentFyiNotifier, type DecisionParentFyiDelivery, type DecisionParentFyiMailbox } from '../../../services/DecisionParentFyiNotifier';
import { prepareWorkerTurnPrompt } from '../../../tools/agents/workerMessaging';

import type { AgentJobTaskTarget } from '../../../database/models/AgentJobMessagingModel';
import type { DecisionRecord } from '@pkg/shared/decisions';

const messaging = vi.hoisted(() => ({ messages: [] as any[], markDelivered: vi.fn(async() => undefined) }));
vi.mock('../../../database/models/AgentJobMessagingModel', () => ({ AgentJobMessagingModel: {
  pendingMessagesForThread: async() => messaging.messages,
  markMessagesDelivered: messaging.markDelivered,
} }));

const asker: AgentJobTaskTarget = {
  jobId: 'child-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', threadId: 'child-thread',
  parentChannel: 'sulla-desktop', parentThreadId: 'parent-thread', label: 'worker', agentId: 'worker',
};
const parentTask: AgentJobTaskTarget = {
  jobId: 'parent-job', taskIndex: 1, jobStatus: 'parked', taskStatus: 'parked', threadId: 'parent-thread', label: 'manager', agentId: 'manager',
};

class FyiDelivery implements DecisionParentFyiDelivery {
  parent: DecisionParentFyiMailbox | null = { channel: 'sulla-desktop', threadId: 'parent-thread', seesOtherAgents: true, task: parentTask };
  readonly agentMessages: string[] = [];
  readonly chatEntries: any[] = [];
  queueAgentMessage = vi.fn(async(_target: AgentJobTaskTarget, message: string) => { this.agentMessages.push(message) });
  enqueueChatQuietly = vi.fn((channel: string, threadId: string, entry: any) => {
    this.chatEntries.push({ channel, threadId, entry });
    return true;
  });

  async askerForThread(): Promise<AgentJobTaskTarget> { return asker }
  async parentMailbox(): Promise<DecisionParentFyiMailbox | null> { return this.parent }
}

function serviceWith(delivery: DecisionParentFyiDelivery) {
  const decisions = { insert: vi.fn(async() => undefined) };
  const pendingDecisions = {
    taskForThread: vi.fn(async() => asker), ancestry: vi.fn(async() => []), findOpenQuestion: vi.fn(async() => undefined),
  };
  const notifier = new DecisionParentFyiNotifier(delivery);
  const service = new DecisionService(undefined, {
    decisions: decisions as any,
    pendingDecisions: pendingDecisions as any,
    routeResolver: { resolve: async() => [] } as any,
    askerWaiter: { park: async() => undefined } as any,
    parentFyiNotifier: notifier,
  });
  return { service, decisions, notifier };
}

function approval(id: string): DecisionRecord {
  return { id, conversationId: 'child-thread', channel: 'sulla-desktop', title: 'Run an action?', kind: 'approval', status: 'pending', createdAt: 1, expiresAt: 10 };
}

describe('DecisionParentFyiNotifier', () => {
  afterEach(() => { messaging.messages = []; vi.restoreAllMocks() });

  it('queues one FYI for approvals, task questions, and consent, but none for a plain question', async() => {
    // risk: authority — parents must know a human-only decision is pending without gaining approval authority.
    const delivery = new FyiDelivery();
    const { service: decisionService, notifier } = serviceWith(delivery);
    const { record: approvalRecord } = await decisionService.request({ kind: 'approval', title: 'Run an action?', toolName: 'shell', conversationId: 'child-thread', channel: 'sulla-desktop' }, 60_000);
    await decisionService.requestQuestion({
      conversationId: 'child-thread', channel: 'sulla-desktop', title: 'Need action?',
      questions: [{ question: 'Need action?', task: true, options: [{ label: 'Done' }] }],
    });
    await decisionService.request({
      kind: 'question', title: 'First contact?', questions: [{ question: 'Allow contact?', options: [{ label: 'Allow' }, { label: 'Block' }] }],
      payload: { decisionAuthority: 'human' }, conversationId: 'child-thread', channel: 'sulla-desktop',
    });
    await decisionService.requestQuestion({
      conversationId: 'child-thread', channel: 'sulla-desktop', title: 'Pick one?',
      questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await notifier.notify(approval(approvalRecord.id));

    expect(delivery.queueAgentMessage).toHaveBeenCalledTimes(3);
    expect(delivery.enqueueChatQuietly).not.toHaveBeenCalled();
  });

  it('skips a missing parent and a parent with Sees other agents turned off', async() => {
    // risk: privacy — a decision note must not enter an absent or explicitly unaware parent's mailbox.
    const delivery = new FyiDelivery();
    const notifier = new DecisionParentFyiNotifier(delivery);
    delivery.parent = null;
    await notifier.notify(approval('no-parent'));
    delivery.parent = { channel: 'sulla-desktop', threadId: 'parent-thread', seesOtherAgents: false, task: parentTask };
    await notifier.notify(approval('unaware-parent'));
    expect(delivery.queueAgentMessage).not.toHaveBeenCalled();
    expect(delivery.enqueueChatQuietly).not.toHaveBeenCalled();
  });

  it('queues a root-parent FYI quietly for the next actual turn without dispatching a wake', async() => {
    // risk: liveness — an FYI cannot start a turn or wake a parked parent.
    const inbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(2_000));
    const dispatch = vi.fn();
    inbox.registerIdleDispatcher(dispatch);
    const delivery = new FyiDelivery();
    delivery.parent = { channel: 'sulla-desktop', threadId: 'parent-thread', seesOtherAgents: true };
    delivery.enqueueChatQuietly = vi.fn((channel, threadId, entry) => inbox.enqueueQuietly(channel, threadId, entry));
    const notifier = new DecisionParentFyiNotifier(delivery);
    await notifier.notify(approval('quiet-parent'));
    await notifier.notify(approval('quiet-parent'));

    expect(dispatch).not.toHaveBeenCalled();
    expect(inbox.take('sulla-desktop', 'parent-thread')).toHaveLength(1);
  });

  it('delivers a worker-parent FYI unchanged at the next tool boundary', async() => {
    // risk: decision delivery — the parent must read the queued FYI as an informational note, not a new command envelope.
    const note = '[FYI from test-sender] opaque-payload-42';
    messaging.messages = [{ id: 'parent-message', jobId: 'parent-job', taskIndex: 1, message: note, createdAt: 1 }];
    messaging.markDelivered.mockClear();
    const prompt = await prepareWorkerTurnPrompt({ metadata: { isSubAgent: true, threadId: 'parent-thread', delegatedJobId: 'parent-job', delegatedTaskIndex: 1 } }, 'next parent turn');

    expect(prompt).toContain(`\n\n${ note }\n\nnext parent turn`);
    expect(prompt).not.toContain(`[Message from orchestrator]\n${ note }`);
    expect(messaging.markDelivered).toHaveBeenCalledWith(['parent-message'], 'parent-thread');
    messaging.messages = [];
  });

  it('does not let FYI queue failure change the pending approval result', async() => {
    // risk: availability — a best-effort parent note failure must never block or revoke the human approval request.
    const delivery = new FyiDelivery();
    delivery.queueAgentMessage.mockRejectedValueOnce(new Error('mailbox unavailable'));
    const { service: decisionService, decisions } = serviceWith(delivery);
    const { record } = await decisionService.request({
      kind: 'approval', title: 'Run an action?', toolName: 'shell', conversationId: 'child-thread', channel: 'sulla-desktop',
    }, 60_000);

    expect(record.status).toBe('pending');
    expect(decisions.insert).toHaveBeenCalledOnce();
  });
});
