// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { MessageEnvelope, ParticipantAddress, type InboxCursor, type OrgMessagingTransport, type WakeHint } from '@sulla/domain';
import { describe, expect, it } from 'vitest';
import { AgentInbox, type AgentInboxEntry, type AgentInboxRepository, type AgentInboxTarget } from '../../../services/AgentInbox';
import { OrgMessenger, type OrgMessagingSession } from '../../../services/OrgMessenger';
import type { OrgMessagingStateRepository, PendingOrgMessage } from '../../../services/OrgMessagingStateRepository';

class MemoryState implements OrgMessagingStateRepository {
  readonly outbox = new Map<string, PendingOrgMessage>();
  readonly cursors = new Map<string, number>();
  async enqueue(message: PendingOrgMessage) { this.outbox.set(message.messageId, message); }
  async pending() { return [...this.outbox.values()]; }
  async markSent(messageId: string) { this.outbox.delete(messageId); }
  async cursor(orgId: string, userId: string): Promise<InboxCursor> { return { orgId, userId, since: this.cursors.get(`${orgId}:${userId}`) ?? 0 }; }
  async advanceCursor(cursor: InboxCursor) { this.cursors.set(`${cursor.orgId}:${cursor.userId}`, cursor.since); }
}

class MemoryInboxRepository implements AgentInboxRepository {
  private readonly entries = new Map<string, AgentInboxEntry>();
  async enqueue(entry: AgentInboxEntry) { const id = entry.envelope.ids.messageId; if (this.entries.has(id)) return false; this.entries.set(id, entry); return true; }
  async claim(target: AgentInboxTarget, owner: string) { return { owner, target, entries: [...this.entries.values()].filter(entry => entry.target.channel === target.channel) }; }
  async renew() {}
  async acknowledge(claim: { entries: AgentInboxEntry[] }) { for (const entry of claim.entries) this.entries.delete(entry.envelope.ids.messageId); }
  async release() {}
  async pendingTargets() { return []; }
}

class TestSession implements OrgMessagingSession {
  async orgId() { return 'org-1'; }
  async userId() { return 'user-1'; }
}

class TestTransport implements OrgMessagingTransport {
  readonly hosting = 'cloud' as const;
  readonly submitted: string[] = [];
  readonly inboxMessages: MessageEnvelope[] = [];
  contactRequestsToResolve: MessageEnvelope[] = [];
  failNextSubmit = false;
  async submit(envelope: MessageEnvelope) { this.submitted.push(envelope.data.messageId); if (this.failNextSubmit) { this.failNextSubmit = false; throw new Error('offline'); } return { status: 'accepted' as const, hostSeq: 1 }; }
  async contactRequests() { return this.contactRequestsToResolve; }
  async resolveContactRequest(_orgId: string, _userId: string, _senderId: string, choice: 'allow_always' | 'just_this_once' | 'block') {
    if (choice !== 'block') this.inboxMessages.push(message('allowed-second', 2), message('allowed-first', 1));
    this.contactRequestsToResolve = [];
    return [1, 2];
  }
  async pull(cursor: InboxCursor) { const messages = this.inboxMessages.filter(message => (message.data.hostSeq ?? 0) > cursor.since); return { messages, next: Math.max(cursor.since, ...messages.map(message => message.data.hostSeq ?? 0)) }; }
  async ack() {}
  async *wakeups(): AsyncIterable<WakeHint> {}
  directory() { return { people: [] }; }
  async claimAgentHost(deviceId: string) { return { userId: 'user-1', deviceId, expiresAt: '' }; }
}

function message(messageId: string, hostSeq?: number): MessageEnvelope {
  return MessageEnvelope.create({ messageId, conversationId: 'conversation-1', orgId: 'org-1',
    from: ParticipantAddress.agent('org-1', 'user-2', 'agent-2'), to: [ParticipantAddress.human('org-1', 'user-1')],
    kind: 'agent', intent: 'request', body: { text: 'please check this', format: 'plain', refs: [] },
    causality: { rootId: messageId, hop: 0, clientSeq: 1 }, provenance: { actingForUserId: 'user-2', placement: 'desktop' },
    createdAt: new Date(0).toISOString(), hostSeq });
}

function outboundMessage(messageId: string): MessageEnvelope {
  return MessageEnvelope.create({ messageId, conversationId: 'conversation-1', orgId: 'org-1',
    from: ParticipantAddress.human('org-1', 'user-1'), to: [ParticipantAddress.human('org-1', 'user-2')],
    kind: 'human', intent: 'note', body: { text: 'hello', format: 'plain', refs: [] },
    causality: { rootId: messageId, hop: 0, clientSeq: 1 }, provenance: { actingForUserId: 'user-1', placement: 'desktop' },
    createdAt: new Date(0).toISOString() });
}

function messenger(transport: TestTransport, state: MemoryState, delivered: string[], capturePrompt?: (resolve: (choice: 'allow_always' | 'just_this_once' | 'block') => Promise<readonly number[]>) => void) {
  const inbox = new AgentInbox(new MemoryInboxRepository(), { isRunning: () => false, wake: async (_target, _batch, entries) => { delivered.push(...entries.map(entry => entry.envelope.ids.messageId)); return 'accepted'; } });
  return new OrgMessenger(transport, new TestSession(), state, inbox, { target: async () => ({ channel: 'user-1', threadId: 'conversation-1' }) }, { request: async (_sender, _messages, resolve) => capturePrompt?.(resolve) });
}

describe('OrgMessenger', () => {
  it('keeps a durable outbox message and retries the identical message id after restart', async () => {
    // risk: duplicate side effect
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    transport.failNextSubmit = true;
    await expect(messenger(transport, state, delivered).send(outboundMessage('stable-id'))).rejects.toThrow('offline');
    await messenger(transport, state, delivered).flushOutbox();
    expect(transport.submitted).toEqual(['stable-id', 'stable-id']);
    expect(state.outbox.size).toBe(0);
  });

  it('persists the host inbox cursor and delivers the org message once across messenger restarts', async () => {
    // risk: duplicate or lost delivery
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    transport.inboxMessages.push(message('incoming-id', 7));
    await messenger(transport, state, delivered).pullInbox();
    await messenger(transport, state, delivered).pullInbox();
    expect(delivered).toEqual(['incoming-id']);
    expect(state.cursors.get('org-1:user-1')).toBe(7);
  });

  it('keeps held first-contact requests out of AgentInbox until the human allows them, then delivers by host sequence', async () => {
    // risk: unauthorized message admission
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    transport.contactRequestsToResolve = [message('held-request')];
    let resolveRequest: ((choice: 'allow_always' | 'just_this_once' | 'block') => Promise<readonly number[]>) | undefined;
    const service = messenger(transport, state, delivered, resolve => { resolveRequest = resolve; });
    await service.syncOnce();
    expect(delivered).toEqual([]);
    await resolveRequest?.('allow_always');
    await service.syncOnce();
    expect(delivered).toEqual(['allowed-first', 'allowed-second']);
  });
});
