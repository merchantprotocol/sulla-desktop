// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '@pkg/shared/decisions';
const sendJobMessageMock = vi.hoisted(() => vi.fn(async() => ({ successBoolean: true, responseString: '' })));
vi.mock('../../../tools/agents/send_job_message', () => ({ sendJobMessage: sendJobMessageMock }));
import { PublishApprovalCoordinator } from '../../../tools/files/PublishApprovalCoordinator';
import { PublishApprovalOutcomeDelivery } from '../../../tools/files/PublishApprovalOutcomeDelivery';

function decision(status: DecisionRecord['status'], id = 'decision-1'): DecisionRecord {
  return {
    id, conversationId: 'child-thread', channel: 'root-channel', title: 'Publish draft?', kind: 'approval', status,
    createdAt: 100, expiresAt: 200, payload: { filesPublishRequestId: 'files-request-1' },
    requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-1', taskIndex: 0 },
  };
}

describe('PublishApprovalCoordinator', () => {
  it('delivers every terminal result from the persisted decision and gives expiry a fresh-request instruction', async() => {
    let listener: ((record: DecisionRecord) => void) | undefined;
    const source = { subscribe: (next: (record: DecisionRecord) => void) => { listener = next; return () => { listener = undefined } } };
    const deliver = vi.fn(async() => true);
    const subject = new PublishApprovalCoordinator(source, { deliver });
    subject.start();
    listener?.(decision('approved', 'approved'));
    listener?.(decision('denied', 'denied'));
    listener?.(decision('expired', 'expired'));
    listener?.({ ...decision('approved', 'question'), kind: 'question' });

    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    expect(deliver.mock.calls.map(([, message]) => message)).toEqual([
      'File version publish approved.',
      'File version publish request denied.',
      'File version publish request expired. If you still need to publish, request a fresh publish approval.',
    ]);
    expect(deliver.mock.calls[0][0]).toMatchObject({ requestedBy: { jobId: 'job-1', taskIndex: 0 } });
    subject.dispose();
  });

  it('routes persisted job requesters through the durable job-message path and direct chats through decision follow-up', async() => {
    const sendJob = vi.fn(async() => true);
    const sendChat = vi.fn(async() => true);
    const delivery = new PublishApprovalOutcomeDelivery(
      { send: sendJob },
      { send: sendChat },
    );

    await delivery.deliver(decision('approved'), 'File version publish approved.');
    expect(sendJob).toHaveBeenCalledWith('job-1', 0, 'File version publish approved.');
    expect(sendChat).not.toHaveBeenCalled();

    const direct = { ...decision('denied'), conversationId: 'chat-thread', requestedBy: undefined };
    await delivery.deliver(direct, 'File version publish request denied.');
    expect(sendChat).toHaveBeenCalledWith('root-channel', 'chat-thread', 'File version publish request denied.');
  });

  it('uses the existing send_job_message delivery path for the persisted requesting task', async() => {
    // risk: agent continuity — the requester identity on the decision must reach the existing parked/running job delivery machinery.
    sendJobMessageMock.mockClear();
    const delivery = new PublishApprovalOutcomeDelivery();

    await expect(delivery.deliver(decision('approved'), 'File version publish approved.')).resolves.toBe(true);

    expect(sendJobMessageMock).toHaveBeenCalledWith({ jobId: 'job-1', taskIndex: 0, message: 'File version publish approved.' });
  });

  it('delivers approved, denied, and expired outcomes to the requesting delegated task', async() => {
    let listener: ((record: DecisionRecord) => void) | undefined;
    const source = { subscribe: (next: (record: DecisionRecord) => void) => { listener = next; return () => { listener = undefined } } };
    const sendJob = vi.fn(async() => true);
    const sendChat = vi.fn(async() => true);
    const subject = new PublishApprovalCoordinator(source, new PublishApprovalOutcomeDelivery(
      { send: sendJob },
      { send: sendChat },
    ));
    subject.start();
    listener?.(decision('approved', 'approved'));
    listener?.(decision('denied', 'denied'));
    listener?.(decision('expired', 'expired'));

    await vi.waitFor(() => expect(sendJob).toHaveBeenCalledTimes(3));
    expect(sendJob.mock.calls).toEqual([
      ['job-1', 0, 'File version publish approved.'],
      ['job-1', 0, 'File version publish request denied.'],
      ['job-1', 0, 'File version publish request expired. If you still need to publish, request a fresh publish approval.'],
    ]);
    expect(sendChat).not.toHaveBeenCalled();
    subject.dispose();
  });

  it('does not deliver duplicate terminal events and unsubscribes on dispose', async() => {
    let listener: ((record: DecisionRecord) => void) | undefined;
    const source = { subscribe: (next: (record: DecisionRecord) => void) => { listener = next; return () => { listener = undefined } } };
    const deliver = vi.fn(async() => true);
    const subject = new PublishApprovalCoordinator(source, { deliver });
    subject.start();
    listener?.(decision('approved'));
    listener?.(decision('approved'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    subject.dispose();
    listener?.(decision('denied'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
