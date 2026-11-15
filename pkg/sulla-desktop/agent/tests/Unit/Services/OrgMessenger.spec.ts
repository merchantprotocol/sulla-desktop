// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { InMemoryOrgMessagingTransport, MessageAdmissionService, MessageEnvelope, OrgMessagingTransportContract, ParticipantAddress, type ContactRequestChoice, type InboxCursor, type OrgMessagingTransport, type WakeHint } from '@sulla/domain';
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
  readonly hosting = 'server' as const;
  private admission: 'accepted' | 'held' | 'denied' = 'accepted';
  private readonly host = new InMemoryOrgMessagingTransport(new MessageAdmissionService(async () => this.admission));
  readonly submitted: string[] = [];
  failNextSubmit = false;
  holdNext() { this.admission = 'held'; }
  acceptNext() { this.admission = 'accepted'; }
  async submit(envelope: MessageEnvelope) {
    this.submitted.push(envelope.data.messageId);
    const result = await this.host.submit(envelope);
    if (this.failNextSubmit) { this.failNextSubmit = false; throw new Error('offline'); }
    return result;
  }
  contactRequests(orgId: string, recipientUserId: string) { return this.host.contactRequests(orgId, recipientUserId); }
  resolveContactRequest(orgId: string, recipientUserId: string, senderUserId: string, choice: ContactRequestChoice) { return this.host.resolveContactRequest(orgId, recipientUserId, senderUserId, choice); }
  pull(cursor: InboxCursor, limit: number) { return this.host.pull(cursor, limit); }
  ack(cursor: InboxCursor, stage: 'stored' | 'consumed') { return this.host.ack(cursor, stage); }
  wakeups() { return this.host.wakeups(); }
  directory() { return this.host.directory(); }
  claimAgentHost(deviceId: string) { return this.host.claimAgentHost(deviceId); }
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

function messenger(transport: TestTransport, state: MemoryState, delivered: string[], capturePrompt?: (resolve: (choice: 'allow_always' | 'just_this_once' | 'block') => Promise<readonly number[]>) => void, halt?: (target: AgentInboxTarget) => Promise<void>) {
  const inbox = new AgentInbox(new MemoryInboxRepository(), { isRunning: () => false, wake: async (_target, _batch, entries) => { delivered.push(...entries.map(entry => entry.envelope.ids.messageId)); return 'accepted'; } });
  return new OrgMessenger(transport, new TestSession(), state, inbox, { target: async () => ({ channel: 'user-1', threadId: 'conversation-1' }) }, { request: async (_sender, _messages, resolve) => capturePrompt?.(resolve) }, { halt: async target => halt?.(target) });
}

function haltMessage(): MessageEnvelope {
  return MessageEnvelope.create({ messageId: 'halt-id', conversationId: 'conversation-1', orgId: 'org-1',
    from: ParticipantAddress.human('org-1', 'user-1'), to: [ParticipantAddress.agent('org-1', 'user-1', 'agent-1')],
    kind: 'control', intent: 'note', control: { action: 'halt' }, body: { text: 'halt', format: 'plain', refs: [] },
    causality: { rootId: 'halt-id', hop: 0, clientSeq: 1 }, provenance: { actingForUserId: 'user-1', placement: 'desktop' },
    createdAt: new Date(0).toISOString() });
}

function agentPost(): MessageEnvelope {
  return MessageEnvelope.create({ messageId: 'agent-post-after-halt', conversationId: 'conversation-1', orgId: 'org-1',
    from: ParticipantAddress.agent('org-1', 'user-1', 'agent-1'), to: [ParticipantAddress.human('org-1', 'user-2')],
    kind: 'agent', intent: 'reply', body: { text: 'reply', format: 'plain', refs: [] },
    causality: { rootId: 'agent-post-after-halt', hop: 1, clientSeq: 1 }, provenance: { actingForUserId: 'user-1', placement: 'desktop' },
    createdAt: new Date(0).toISOString() });
}

describe('OrgMessenger', () => {
  it('satisfies the shared host transport behavior contract', async () => {
    // risk: cross-tenant delivery, duplicates, or bypassed contact consent
    await new OrgMessagingTransportContract().verify(
      admission => new InMemoryOrgMessagingTransport(admission),
      (condition, message) => { if (!condition) throw new Error(message); },
    );
  });

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
    await transport.submit(message('incoming-id', 7));
    await messenger(transport, state, delivered).pullInbox();
    await messenger(transport, state, delivered).pullInbox();
    expect(delivered).toEqual(['incoming-id']);
    expect(state.cursors.get('org-1:user-1')).toBe(1);
  });

  it('keeps held first-contact requests out of AgentInbox until the human allows them, then delivers by host sequence', async () => {
    // risk: unauthorized message admission
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    transport.holdNext();
    await transport.submit(message('held-request'));
    let resolveRequest: ((choice: 'allow_always' | 'just_this_once' | 'block') => Promise<readonly number[]>) | undefined;
    const service = messenger(transport, state, delivered, resolve => { resolveRequest = resolve; });
    await service.syncOnce();
    expect(delivered).toEqual([]);
    transport.acceptNext();
    await resolveRequest?.('allow_always');
    await service.syncOnce();
    expect(delivered).toEqual(['held-request']);
  });

  it('refuses agent posts after a control halt and cancels the local running conversation', async () => {
    // risk: unauthorized agent side effect after a human halt
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    await transport.submit(haltMessage());
    const stopped: AgentInboxTarget[] = [];
    const service = messenger(transport, state, delivered, undefined, async target => { stopped.push(target); });
    await service.pullInbox();
    expect(stopped).toEqual([{ channel: 'user-1', threadId: 'conversation-1' }]);
    await expect(service.send(agentPost())).rejects.toThrow('halted');
    expect(transport.submitted).toEqual(['halt-id']);
  });
});
