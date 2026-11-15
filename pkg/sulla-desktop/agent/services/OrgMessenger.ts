// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentInboxBridge, EnvelopeCodec, type ContactRequestChoice, type InboxCursor, type MessageEnvelope, type OrgMessagingTransport } from '@sulla/domain';
import type { AgentInbox, AgentInboxTarget } from './AgentInbox';
import type { OrgMessagingStateRepository } from './OrgMessagingStateRepository';

export interface OrgMessagingSession { orgId(): Promise<string>; userId(): Promise<string> }
export interface OrgContactRequestPrompter { request(senderUserId: string, messages: readonly MessageEnvelope[], resolve: (choice: ContactRequestChoice) => Promise<readonly number[]>): Promise<void> }
export interface OrgInboxTargetResolver { target(envelope: MessageEnvelope): Promise<AgentInboxTarget> }
export interface OrgConversationHaltHandler { halt(target: AgentInboxTarget): Promise<void> }
export interface OrgMessagingDeviceIdentity { deviceId(): Promise<string> }

/** Coordinates durable outbox retries, cursor-driven inbox delivery, and first-contact holds. */
export class OrgMessenger {
  private readonly bridge = new AgentInboxBridge();
  private readonly codec = new EnvelopeCodec();
  constructor(
    private readonly transport: OrgMessagingTransport,
    private readonly session: OrgMessagingSession,
    private readonly state: OrgMessagingStateRepository,
    private readonly inbox: AgentInbox,
    private readonly targetResolver: OrgInboxTargetResolver,
    private readonly contactPrompter: OrgContactRequestPrompter,
    private readonly haltHandler?: OrgConversationHaltHandler,
    private readonly deviceIdentity: OrgMessagingDeviceIdentity = { deviceId: async() => (await import('@pkg/main/deviceIdentity')).getDesktopDeviceId() },
    private readonly pageSize = 50,
  ) {}

  private readonly haltedConversations = new Set<string>();

  async send(envelope: MessageEnvelope): Promise<void> {
    const [orgId, userId] = await Promise.all([this.session.orgId(), this.session.userId()]);
    if (envelope.data.orgId !== orgId || envelope.data.from.userId !== userId || envelope.data.provenance.actingForUserId !== userId) {
      throw new Error('Org message must belong to the active human and organization');
    }
    if (envelope.data.kind === 'agent' && this.haltedConversations.has(`${orgId}:${envelope.data.conversationId}`)) {
      throw new Error('This organization conversation is halted');
    }
    // Persist the canonical wire representation: MessageEnvelope.toJSON() keeps
    // ParticipantAddress instances, while decode() intentionally accepts only
    // canonical address strings.
    await this.state.enqueue({ messageId: envelope.data.messageId, envelope: this.codec.encode(envelope) });
    await this.flushOutbox();
    if (envelope.data.kind === 'control' && envelope.data.control?.action === 'halt') {
      this.haltedConversations.add(`${orgId}:${envelope.data.conversationId}`);
      await this.haltHandler?.halt(await this.targetResolver.target(envelope));
    }
  }

  async flushOutbox(): Promise<number> {
    let sent = 0;
    for (const item of await this.state.pending()) {
      const result = await this.transport.submit(this.codec.decode(item.envelope));
      if (result.status === 'accepted' || result.status === 'duplicate' || result.status === 'held') {
        await this.state.markSent(item.messageId);
        sent++;
      }
    }
    return sent;
  }

  async pullInbox(): Promise<number> {
    const [orgId, userId] = await Promise.all([this.session.orgId(), this.session.userId()]);
    let cursor: InboxCursor = await this.state.cursor(orgId, userId);
    let delivered = 0;
    while (true) {
      const page = await this.transport.pull(cursor, this.pageSize);
      const ordered = [...page.messages].sort((a, b) => (a.data.hostSeq ?? 0) - (b.data.hostSeq ?? 0));
      for (const envelope of ordered) {
        const target = await this.targetResolver.target(envelope);
        if (envelope.data.kind === 'control' && envelope.data.control?.action === 'halt') {
          this.haltedConversations.add(`${orgId}:${envelope.data.conversationId}`);
          await this.haltHandler?.halt(target);
          delivered++;
          continue;
        }
        const local = this.bridge.toLocal(envelope, target.channel);
        await this.inbox.receive({
          envelope: { from: local.from, kind: local.kind, body: `${this.bridge.label(envelope)}\n${local.body}`, ids: { ...local.ids, messageId: local.messageId, relayed: true } },
          target,
        });
        delivered++;
      }
      const previous = cursor.since;
      const next = Math.max(previous, page.next);
      if (next > cursor.since) {
        cursor = { orgId, userId, since: next };
        await this.state.advanceCursor(cursor);
      }
      if (ordered.length < this.pageSize || next <= previous || !ordered.length) break;
    }
    return delivered;
  }

  async checkContactRequests(): Promise<void> {
    const [orgId, userId] = await Promise.all([this.session.orgId(), this.session.userId()]);
    const requests = await this.transport.contactRequests(orgId, userId);
    const senders = new Map<string, MessageEnvelope[]>();
    for (const request of requests) {
      const sender = request.data.from.userId;
      const group = senders.get(sender) ?? [];
      group.push(request);
      senders.set(sender, group);
    }
    for (const [sender, messages] of senders) {
      await this.contactPrompter.request(sender, messages, choice => this.transport.resolveContactRequest(orgId, userId, sender, choice));
    }
  }

  async syncOnce(): Promise<{ sent: number; delivered: number }> {
    const sent = await this.flushOutbox();
    await this.checkContactRequests();
    const delivered = await this.pullInbox();
    return { sent, delivered };
  }

  async run(signal: AbortSignal): Promise<void> {
    let backoffMs = 15_000;
    while (!signal.aborted) {
      try {
        const [orgId, userId] = await Promise.all([this.session.orgId(), this.session.userId()]);
        if (!orgId || !userId) {
          await this.wait(signal, 15_000);
          continue;
        }
        const deviceId = await this.deviceIdentity.deviceId();
        const lease = await this.transport.claimAgentHost(deviceId);
        if (lease.deviceId !== deviceId || (lease.userId && lease.userId !== userId)) throw new Error('This Desktop does not hold the organization agent-host lease');
        await this.syncOnce();
        backoffMs = 15_000;
        // Cloud transport wakeups are polling-based today. This interval also
        // renews the host lease and observes sign-out / active-org changes.
        await this.wait(signal, 15_000);
      } catch {
        await this.wait(signal, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 120_000);
      }
    }
  }

  private wait(signal: AbortSignal, milliseconds: number): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, milliseconds);
      const onAbort = () => done();
      function done() { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(); }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
