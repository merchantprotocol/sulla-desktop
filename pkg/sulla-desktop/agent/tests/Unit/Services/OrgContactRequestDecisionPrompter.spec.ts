// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { MessageEnvelope, ParticipantAddress } from '@sulla/domain';
import { describe, expect, it, vi } from 'vitest';
import { OrgContactRequestDecisionPrompter, type ContactDecisionStore, type ContactQuestionCardEmitter } from '../../../services/OrgContactRequestDecisionPrompter';
import type { OrgContactPrompt } from '../../../services/OrgMessenger';

function heldMessage() {
  return MessageEnvelope.create({
    messageId: 'held-1', conversationId: 'conversation-1', orgId: 'org-1',
    from: ParticipantAddress.agent('org-1', 'sender-id', 'agent'), to: [ParticipantAddress.human('org-1', 'recipient-id')],
    kind: 'agent', intent: 'request', body: { text: 'hello', format: 'plain', refs: [] },
    causality: { rootId: 'held-1', hop: 0, clientSeq: 1 }, provenance: { actingForUserId: 'sender-id', placement: 'desktop' },
    createdAt: new Date(0).toISOString(),
  });
}

function prompt(resolve: OrgContactPrompt['resolve']): OrgContactPrompt {
  return { orgId: 'org-1', senderUserId: 'sender-id', senderName: 'Dana', messages: [heldMessage()], shown: vi.fn(async () => {}), resolve };
}

function decisions(result: Promise<{ status: string; answers: { selected: string[] }[] }>): ContactDecisionStore {
  return { request: async () => ({ record: { id: 'decision-1' }, result }), expire: vi.fn(async () => {}) };
}

describe('OrgContactRequestDecisionPrompter', () => {
  it('marks first-contact consent as human-only in the durable decision record', async () => {
    // risk: consent — a delegated parent must never grant an organization contact request on the human's behalf.
    const request = vi.fn(async () => ({ record: { id: 'decision-consent' }, result: new Promise<{ status: string; answers: { selected: string[] }[] }>(() => {}) }));
    const decisionStore = { request, expire: vi.fn(async () => {}) } as unknown as ContactDecisionStore;
    const service = new OrgContactRequestDecisionPrompter(decisionStore, { emit: async () => true });

    await service.request(prompt(vi.fn(async () => [])));

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { decisionAuthority: 'human' } }), expect.any(Number));
  });

  it('does not resolve a held request when the question card cannot be sent', async () => {
    // risk: missing UI delivery must never implicitly deny a trusted contact request
    const resolve = vi.fn(async () => []);
    const emitter: ContactQuestionCardEmitter = { emit: async () => false };
    const decisionStore = decisions(new Promise(() => {}));
    const service = new OrgContactRequestDecisionPrompter(decisionStore, emitter);
    await service.request(prompt(resolve));
    await new Promise(resolveTick => setTimeout(resolveTick, 0));
    expect(resolve).not.toHaveBeenCalled();
    expect(decisionStore.expire).toHaveBeenCalledWith('decision-1');
  });

  it.each(['expired', 'unanswered'])('does not resolve when the card is %s', async status => {
    // risk: expiry or dismissal must not become an implicit deny/allow decision
    const resolve = vi.fn(async () => []);
    const emitter: ContactQuestionCardEmitter = { emit: async () => true };
    const decisionStore = decisions(Promise.resolve({ status, answers: [] }));
    const service = new OrgContactRequestDecisionPrompter(decisionStore, emitter);
    await service.request(prompt(resolve));
    await new Promise(resolveTick => setTimeout(resolveTick, 0));
    expect(resolve).not.toHaveBeenCalled();
  });
});
