// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '@pkg/shared/decisions';
const sendJobMessageMock = vi.hoisted(() => vi.fn(async() => ({ successBoolean: true, responseString: '' })));
vi.mock('../../../tools/agents/send_job_message', () => ({ sendJobMessage: sendJobMessageMock }));
import { PublishApprovalCoordinator } from '../../../tools/files/PublishApprovalCoordinator';
import { PublishApprovalOutcomeDelivery } from '../../../tools/files/PublishApprovalOutcomeDelivery';
import { PublishApprovalOutcomeMessage } from '../../../tools/files/PublishApprovalOutcomeMessage';
import { PublishApprovalRouter } from '../../../tools/files/PublishApprovalRouter';

function decision(status: DecisionRecord['status'], id = 'decision-1'): DecisionRecord {
  return {
    id, conversationId: 'child-thread', channel: 'root-channel', title: "Activate agent 'coding-manager' v2?", kind: 'approval', status,
    createdAt: 100, expiresAt: 200, payload: { filesPublishRequestId: 'files-request-1' },
    requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-1', taskIndex: 0 },
  };
}

const router = new PublishApprovalRouter({ taskForThread: async() => null });
const wording = new PublishApprovalOutcomeMessage({ name: async() => 'Jonathon' });
const APPROVED = `[Human decision] Jonathon approved publishing "Activate agent 'coding-manager' v2" (decision approved).`;
const DENIED = `[Human decision] Jonathon denied publishing "Activate agent 'coding-manager' v2" (decision denied).`;
const EXPIRED = `[Human decision] The request to publish "Activate agent 'coding-manager' v2" (decision expired) expired: request a fresh publish if still needed.`;

class DecisionFeed {
  private listener?: (record: DecisionRecord) => void;
  subscribe(next: (record: DecisionRecord) => void): () => void { this.listener = next; return () => { this.listener = undefined } }
  announce(record: DecisionRecord): void { this.listener?.(record) }
}

describe('PublishApprovalCoordinator', () => {
  it('tells the asker who decided, what was decided and which decision it was', async() => {
    // risk: agent continuity — the asker must be able to tell the human's decision from an instruction and tie it to its own request.
    const feed = new DecisionFeed();
    const deliver = vi.fn(async(_record: DecisionRecord, _message: string) => true);
    const subject = new PublishApprovalCoordinator(feed, { deliver }, wording);
    subject.start();
    feed.announce(decision('approved', 'approved'));
    feed.announce(decision('denied', 'denied'));
    feed.announce(decision('expired', 'expired'));
    feed.announce({ ...decision('approved', 'question'), kind: 'question' });

    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    // The three decisions are independent, so their delivery order is not part of the contract.
    expect(deliver.mock.calls.map(([, message]) => message).sort()).toEqual([APPROVED, DENIED, EXPIRED].sort());
    expect(deliver.mock.calls.map(([, message]) => message).join('\n')).not.toMatch(/orchestrator|manager/i);
    expect(deliver.mock.calls.every(([record]) => record.requestedBy?.jobId === 'job-1' && record.requestedBy.taskIndex === 0)).toBe(true);
    subject.dispose();
  });

  it('says "The human" when the app has no name for them', async() => {
    const unnamed = new PublishApprovalOutcomeMessage({ name: async() => '  ' });
    const unreadable = new PublishApprovalOutcomeMessage({ name: async() => { throw new Error('settings unavailable') } });

    await expect(unnamed.for(decision('denied', 'd-9'))).resolves.toBe(`[Human decision] The human denied publishing "Activate agent 'coding-manager' v2" (decision d-9).`);
    await expect(unreadable.for(decision('approved', 'd-9'))).resolves.toBe(`[Human decision] The human approved publishing "Activate agent 'coding-manager' v2" (decision d-9).`);
  });

  it('routes persisted job requesters through the durable job-message path and direct chats through decision follow-up', async() => {
    const sendJob = vi.fn(async() => true);
    const sendChat = vi.fn(async() => true);
    const delivery = new PublishApprovalOutcomeDelivery(router, { send: sendJob }, { send: sendChat });

    await delivery.deliver(decision('approved'), APPROVED);
    expect(sendJob).toHaveBeenCalledWith('job-1', 0, APPROVED);
    expect(sendChat).not.toHaveBeenCalled();

    const direct = { ...decision('denied'), conversationId: 'chat-thread', requestedBy: undefined };
    await delivery.deliver(direct, DENIED);
    expect(sendChat).toHaveBeenCalledWith('root-channel', 'chat-thread', DENIED);
  });

  it('uses the existing send_job_message delivery path for the persisted requesting task', async() => {
    // risk: agent continuity — the requester identity on the decision must reach the existing parked/running job delivery machinery.
    sendJobMessageMock.mockClear();
    const delivery = new PublishApprovalOutcomeDelivery(router);

    await expect(delivery.deliver(decision('approved'), APPROVED)).resolves.toBe(true);

    expect(sendJobMessageMock).toHaveBeenCalledWith({ jobId: 'job-1', taskIndex: 0, message: APPROVED });
  });

  it('delivers approved, denied, and expired outcomes to the requesting delegated task', async() => {
    const feed = new DecisionFeed();
    const sendJob = vi.fn(async() => true);
    const sendChat = vi.fn(async() => true);
    const subject = new PublishApprovalCoordinator(feed, new PublishApprovalOutcomeDelivery(router, { send: sendJob }, { send: sendChat }), wording);
    subject.start();
    feed.announce(decision('approved', 'approved'));
    feed.announce(decision('denied', 'denied'));
    feed.announce(decision('expired', 'expired'));

    await vi.waitFor(() => expect(sendJob).toHaveBeenCalledTimes(3));
    expect(sendJob.mock.calls).toHaveLength(3);
    expect(sendJob.mock.calls).toEqual(expect.arrayContaining([['job-1', 0, APPROVED], ['job-1', 0, DENIED], ['job-1', 0, EXPIRED]]));
    expect(sendChat).not.toHaveBeenCalled();
    subject.dispose();
  });

  it('does not deliver duplicate terminal events and unsubscribes on dispose', async() => {
    const feed = new DecisionFeed();
    const deliver = vi.fn(async() => true);
    const subject = new PublishApprovalCoordinator(feed, { deliver }, wording);
    subject.start();
    feed.announce(decision('approved'));
    feed.announce(decision('approved'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    subject.dispose();
    feed.announce(decision('denied'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
