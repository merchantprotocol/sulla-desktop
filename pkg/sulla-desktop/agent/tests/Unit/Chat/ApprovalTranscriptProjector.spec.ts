// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ApprovalTranscriptProjector } from '../../../../pages/chat/services/ApprovalTranscriptProjector';
import type { DecisionRecord } from '@pkg/shared/decisions';

describe('ApprovalTranscriptProjector', () => {
  it('rebuilds a pending child approval from the root conversation decision after reload', () => {
    // risk: user consent — a hidden child approval must still be visible/actionable when the root transcript has no card message.
    const record: DecisionRecord = {
      id: 'child-approval', conversationId: 'child-thread', relatedConversationIds: ['child-thread', 'root-thread'],
      channel: 'child-channel', kind: 'approval', status: 'pending', title: 'Publish this agent?', toolName: 'files_request_publish',
      createdAt: 100, expiresAt: 700, payload: { filesPublishRequestId: 'request-1' },
      approvalPresentation: { reason: 'Publishing makes the draft available.', command: 'Files draft publication', origin: { kind: 'files_publish' } },
      requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-1', taskIndex: 2 },
    };

    const projector = new ApprovalTranscriptProjector();
    const projected = projector.project([], [record], 'root-thread');
    // Once decided from this card, the card stays so the human sees the outcome.
    expect(projector.project([], [{ ...record, status: 'approved' }], 'root-thread')).toHaveLength(1);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      kind: 'tool_approval', approvalId: record.id, title: record.title, reason: record.approvalPresentation.reason,
      command: record.approvalPresentation.command, expiresAt: record.expiresAt, origin: record.approvalPresentation.origin,
      requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent' },
    });
  });

  it('does not duplicate a transcript card or project settled and unrelated approvals', () => {
    // risk: consent integrity — reload recovery must only add the exact active approval, once.
    const base: DecisionRecord = {
      id: 'approval', conversationId: 'child-thread', relatedConversationIds: ['child-thread', 'root-thread'],
      channel: 'channel', kind: 'approval', status: 'pending', title: 'Publish?', toolName: 'files_request_publish',
      createdAt: 100, expiresAt: 700, payload: { filesPublishRequestId: 'request-1' },
    };
    const transcript = [{ id: 'existing', kind: 'tool_approval', approvalId: base.id, createdAt: 100 } as any];

    expect(new ApprovalTranscriptProjector().project(transcript, [
      base,
      { ...base, id: 'settled', status: 'approved' },
      { ...base, id: 'other', relatedConversationIds: ['other-thread'] },
    ], 'root-thread')).toEqual(transcript);
  });
});
