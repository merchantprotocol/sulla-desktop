// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { InMemoryOrgMessagingTransport, MessageAdmissionService, MessageEnvelope, OrgMessagingTransportContract, ParticipantAddress, type ContactRequestChoice, type InboxCursor, type OrgMessagingTransport, type WakeHint } from '@sulla/domain';
import { describe, expect, it } from 'vitest';
import { AgentInbox, type AgentInboxEntry, type AgentInboxRepository, type AgentInboxTarget } from '../../../services/AgentInbox';
import { OrgMessenger, type OrgContactPrompt, type OrgConversationStartRequest, type OrgMessagingSession } from '../../../services/OrgMessenger';
import type { OrgMessagingStateRepository, PendingOrgMessage } from '../../../services/OrgMessagingStateRepository';

class MemoryState implements OrgMessagingStateRepository {
  readonly outbox = new Map<string, PendingOrgMessage>();
  readonly cursors = new Map<string, number>();
  readonly failures = new Map<string, string>();
  readonly askedAt = new Map<string, number>();
  async enqueue(message: PendingOrgMessage) { this.outbox.set(`${message.orgId}:${message.messageId}`, message); }
  async pending(orgId: string) { return [...this.outbox.values()].filter(item => item.orgId === orgId && !this.failures.has(`${item.orgId}:${item.messageId}`)); }
  async markSent(orgId: string, messageId: string) { this.outbox.delete(`${orgId}:${messageId}`); }
  async markFailed(orgId: string, messageId: string, reason: string) { this.failures.set(`${orgId}:${messageId}`, reason); }
  async cursor(orgId: string, userId: string): Promise<InboxCursor> { return { orgId, userId, since: this.cursors.get(`${orgId}:${userId}`) ?? 0 }; }
  async advanceCursor(cursor: InboxCursor) { this.cursors.set(`${cursor.orgId}:${cursor.userId}`, cursor.since); }
  async lastContactPrompt(orgId: string, userId: string, senderUserId: string) { return this.askedAt.get(`${orgId}:${userId}:${senderUserId}`); }
  async recordContactPrompt(orgId: string, userId: string, senderUserId: string, at: number) { this.askedAt.set(`${orgId}:${userId}:${senderUserId}`, at); }
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
  readonly submittedConversations: string[] = [];
  readonly operations: string[] = [];
  readonly started: OrgConversationStartRequest[] = [];
  people: readonly unknown[] = [];
  leaseClaims = 0;
  directoryLoads = 0;
  private readonly conversations = new Map<string, string>();
  failNextSubmit = false;
  holdNext() { this.admission = 'held'; }
  acceptNext() { this.admission = 'accepted'; }
  denyNext() { this.admission = 'denied'; }
  async startConversation(request: OrgConversationStartRequest) {
    this.operations.push('start');
    this.started.push(request);
    const key = `${request.kind}:${[...request.participantUserIds].sort().join(':')}`;
    const existing = request.kind === 'group' ? undefined : this.conversations.get(key);
    const conversationId = existing ?? request.conversationId;
    if (request.kind !== 'group') this.conversations.set(key, conversationId);
    return { conversationId };
  }
  async submit(envelope: MessageEnvelope) {
    this.operations.push('submit');
    this.submitted.push(envelope.data.messageId);
    this.submittedConversations.push(envelope.data.conversationId);
    const result = await this.host.submit(envelope);
    if (this.failNextSubmit) { this.failNextSubmit = false; throw new Error('offline'); }
    return result;
  }
  contactRequests(orgId: string, recipientUserId: string) { return this.host.contactRequests(orgId, recipientUserId); }
  resolveContactRequest(orgId: string, recipientUserId: string, senderUserId: string, choice: ContactRequestChoice) { return this.host.resolveContactRequest(orgId, recipientUserId, senderUserId, choice); }
  pull(cursor: InboxCursor, limit: number) { return this.host.pull(cursor, limit); }
  ack(cursor: InboxCursor, stage: 'stored' | 'consumed') { return this.host.ack(cursor, stage); }
  wakeups() { return this.host.wakeups(); }
  directory() { return { people: this.people }; }
  loadDirectory() { this.directoryLoads++; return Promise.resolve(this.directory()); }
  claimAgentHost(deviceId: string) { this.leaseClaims++; return this.host.claimAgentHost(deviceId); }
  count() { return this.host.count(); }
}

function message(messageId: string, hostSeq?: number): MessageEnvelope {
  return MessageEnvelope.create({ messageId, conversationId: 'conversation-1', orgId: 'org-1',
    from: ParticipantAddress.agent('org-1', 'user-2', 'agent-2'), to: [ParticipantAddress.human('org-1', 'user-1')],
    kind: 'agent', intent: 'request', body: { text: 'please check this', format: 'plain', refs: [] },
    causality: { rootId: messageId, hop: 0, clientSeq: 1 }, provenance: { actingForUserId: 'user-2', placement: 'desktop' },
    createdAt: new Date(0).toISOString(), hostSeq });
}

function outboundMessage(messageId: string, conversationId = 'conversation-1'): MessageEnvelope {
  return MessageEnvelope.create({ messageId, conversationId, orgId: 'org-1',
    from: ParticipantAddress.human('org-1', 'user-1'), to: [ParticipantAddress.human('org-1', 'user-2')],
    kind: 'human', intent: 'note', body: { text: 'hello', format: 'plain', refs: [] },
    causality: { rootId: messageId, hop: 0, clientSeq: 1 }, provenance: { actingForUserId: 'user-1', placement: 'desktop' },
    createdAt: new Date(0).toISOString() });
}

function messenger(transport: TestTransport, state: MemoryState, delivered: string[], capturePrompt?: (resolve: (choice: 'allow_always' | 'just_this_once' | 'block') => Promise<readonly number[]>) => void, halt?: (target: AgentInboxTarget) => Promise<void>, inboxDeliveries?: AgentInboxEntry[], inboxRepository: AgentInboxRepository = new MemoryInboxRepository(), requestPrompt?: (prompt: OrgContactPrompt) => Promise<void>) {
  const inbox = new AgentInbox(inboxRepository, { isRunning: () => false, wake: async (_target, _batch, entries) => { inboxDeliveries?.push(...entries); delivered.push(...entries.map(entry => entry.envelope.ids.remoteMessageId ?? entry.envelope.ids.messageId)); return 'accepted'; } });
  return new OrgMessenger(transport, new TestSession(), state, inbox, { target: async () => ({ channel: 'user-1', threadId: 'conversation-1' }) }, { request: async prompt => { capturePrompt?.(prompt.resolve); await requestPrompt?.(prompt); } }, { halt: async target => halt?.(target) }, { deviceId: async () => 'device-1' });
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
  it('loads participant inbox pages without advancing the sync cursor', async () => {
    // risk: data accuracy and duplicate/missing inbox rows caused by UI reads consuming sync state
    const state = new MemoryState(); const delivered: string[] = [];
    class PagedTransport extends TestTransport {
      readonly cursors: number[] = [];
      async pull(cursor: InboxCursor, _limit: number) {
        this.cursors.push(cursor.since);
        if (cursor.since === 0) return { messages: Array.from({ length: 50 }, (_, index) => message(`page-${index + 1}`, index + 1)), next: 50 };
        return { messages: [message('page-51', 51)], next: 51 };
      }
    }
    const transport = new PagedTransport();
    const result = await messenger(transport, state, delivered).loadInboxMessages();

    expect(result).toHaveLength(51);
    expect(transport.cursors).toEqual([0, 50]);
    expect(state.cursors.size).toBe(0);
  });

  it('starts a direct conversation before first send and uses the host-reused pair id', async () => {
    // risk: first contact cannot start or messages target a nonexistent conversation
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    const service = messenger(transport, state, delivered);
    await service.send(outboundMessage('first-message', 'client-conversation-1'));
    await service.send(outboundMessage('second-message', 'client-conversation-2'));
    expect(transport.started.map(({ kind, participantUserIds }) => ({ kind, participantUserIds }))).toEqual([
      { kind: 'direct', participantUserIds: ['user-1', 'user-2'] },
      { kind: 'direct', participantUserIds: ['user-1', 'user-2'] },
    ]);
    expect(transport.operations).toEqual(['start', 'submit', 'start', 'submit']);
    expect(transport.submittedConversations).toEqual(['client-conversation-1', 'client-conversation-1']);
  });

  it('starts an agent thread before the first agent message is submitted', async () => {
    // risk: org/send_message posts to a conversation the Cloud host has not started
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    await messenger(transport, state, delivered).send(agentPost());
    expect(transport.started).toEqual([{
      conversationId: 'conversation-1', kind: 'agent_thread', participantUserIds: ['user-1', 'user-2'],
    }]);
    expect(transport.operations).toEqual(['start', 'submit']);
    expect(transport.submittedConversations).toEqual(['conversation-1']);
  });

  it('satisfies the shared host transport behavior contract', async () => {
    // risk: cross-tenant delivery, duplicates, or bypassed contact consent
    await new OrgMessagingTransportContract().verify(
      admission => new InMemoryOrgMessagingTransport(admission),
      (condition, message) => { if (!condition) throw new Error(message); },
    );
  });

  it('fails the contract when a host breaks message-id duplicate receipts', async () => {
    // risk: duplicate side effects; deliberate broken-host control
    class BrokenHost extends InMemoryOrgMessagingTransport {
      async submit(envelope: MessageEnvelope) {
        const receipt = await super.submit(envelope);
        return { ...receipt, status: 'accepted' as const };
      }
    }
    await expect(new OrgMessagingTransportContract().verify(
      admission => new BrokenHost(admission),
      (condition, message) => { if (!condition) throw new Error(message); },
    )).rejects.toThrow('duplicate retains original sequence');
  });

  it('keeps a durable outbox message and retries the identical message id after restart', async () => {
    // risk: duplicate side effect
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    transport.failNextSubmit = true;
    await expect(messenger(transport, state, delivered).send(outboundMessage('stable-id'))).rejects.toThrow('offline');
    await messenger(transport, state, delivered).flushOutbox();
    expect(transport.submitted).toEqual(['stable-id', 'stable-id']);
    expect(transport.count()).toBe(1);
    expect(state.outbox.size).toBe(0);
  });

  it('marks denied outbox items failed once and returns the denial to send()', async () => {
    // risk: denied messages retry forever or agents miss the authorization failure
    const state = new MemoryState(); const transport = new TestTransport();
    transport.denyNext();
    const service = messenger(transport, state, []);
    await expect(service.send(outboundMessage('denied-id'))).rejects.toThrow('Message denied by organization host');
    await service.flushOutbox();
    expect(transport.submitted).toEqual(['denied-id']);
    expect(state.failures.get('org-1:denied-id')).toBe('Message denied by organization host');
  });

  it('persists the host inbox cursor and delivers the org message once across messenger restarts', async () => {
    // risk: duplicate or lost delivery
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    await transport.submit(message('incoming-id', 7));
    const inboxDeliveries: AgentInboxEntry[] = [];
    const inboxRepository = new MemoryInboxRepository();
    await messenger(transport, state, delivered, undefined, undefined, inboxDeliveries, inboxRepository).pullInbox();
    await messenger(transport, state, delivered, undefined, undefined, inboxDeliveries, inboxRepository).pullInbox();
    expect(delivered).toEqual(['incoming-id']);
    expect(state.cursors.get('org-1:user-1')).toBe(1);
    expect(inboxDeliveries[0]?.envelope.ids.relayed).toBe(true);
    expect(inboxDeliveries[0]?.envelope.body).toContain('untrusted');
  });

  it('keeps held first-contact requests out of AgentInbox until the human allows them, then delivers by host sequence', async () => {
    // risk: unauthorized message admission
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    transport.holdNext();
    await transport.submit(message('held-request-1'));
    await transport.submit(message('held-request-2'));
    let resolveRequest: ((choice: 'allow_always' | 'just_this_once' | 'block') => Promise<readonly number[]>) | undefined;
    const service = messenger(transport, state, delivered, resolve => { resolveRequest = resolve; });
    await service.syncOnce();
    expect(delivered).toEqual([]);
    transport.acceptNext();
    await resolveRequest?.('allow_always');
    await service.syncOnce();
    expect(delivered).toEqual(['held-request-1', 'held-request-2']);
  });

  it('keeps pulling inbox while a contact decision is still open', async () => {
    // risk: a human decision stalls unrelated message delivery
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    transport.holdNext();
    await transport.submit(message('held-open'));
    let unblock!: () => void;
    const openPrompt = new Promise<void>(resolve => { unblock = resolve; });
    const service = messenger(transport, state, delivered, undefined, undefined, undefined, undefined, async () => openPrompt);
    await expect(Promise.race([
      service.syncOnce(),
      new Promise(resolve => setTimeout(() => resolve('blocked-by-prompt'), 25)),
    ])).resolves.not.toBe('blocked-by-prompt');
    unblock();
  });

  it('uses the directory display name and suppresses another prompt for six hours', async () => {
    // risk: repeated trust prompts train users to dismiss or blindly approve them
    const state = new MemoryState(); const transport = new TestTransport();
    transport.people = [{ userId: 'user-2', displayName: 'Dana' }];
    transport.holdNext();
    await transport.submit(message('held-name'));
    const prompts: string[] = [];
    const service = messenger(transport, state, [], undefined, undefined, undefined, undefined, async prompt => {
      prompts.push(prompt.senderName);
      await prompt.shown();
    });
    await service.syncOnce();
    await service.syncOnce();
    expect(prompts).toEqual(['Dana']);
    expect(state.askedAt.has('org-1:user-1:user-2')).toBe(true);
  });

  it('does not claim a host lease or poll when the org has no other members', async () => {
    // risk: unnecessary Cloud polling and load for solo accounts
    const state = new MemoryState(); const transport = new TestTransport(); const service = messenger(transport, state, []);
    const controller = new AbortController();
    const running = service.run(controller.signal);
    while (!transport.directoryLoads) await new Promise(resolve => setTimeout(resolve, 0));
    expect(transport.leaseClaims).toBe(0);
    controller.abort();
    await running;
    expect(transport.operations).toEqual([]);
  });

  it('refuses agent posts after a control halt and cancels the local running conversation', async () => {
    // risk: unauthorized agent side effect after a human halt
    const state = new MemoryState(); const transport = new TestTransport(); const delivered: string[] = [];
    const stopped: AgentInboxTarget[] = [];
    const service = messenger(transport, state, delivered, undefined, async target => { stopped.push(target); });
    await service.send(haltMessage());
    expect(stopped).toEqual([{ channel: 'user-1', threadId: 'conversation-1' }]);
    await expect(service.send(agentPost())).rejects.toThrow('halted');
    expect(transport.submitted).toEqual(['halt-id']);
  });
});
