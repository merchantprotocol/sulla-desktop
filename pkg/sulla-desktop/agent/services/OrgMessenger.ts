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
  }

  async flushOutbox(): Promise<number> {
    let sent = 0;
    for (const item of await this.state.pending()) {
      const result = await this.transport.submit(this.codec.decode(item.envelope));
      if (result.status === 'accepted' || result.status === 'duplicate') {
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
          envelope: { from: local.from, kind: local.kind, body: `${this.bridge.label(envelope)}\n${local.body}`, ids: { ...local.ids, messageId: local.messageId } },
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
    while (!signal.aborted) {
      try {
        await this.syncOnce();
        for await (const _hint of this.transport.wakeups()) {
          if (signal.aborted) return;
          await this.syncOnce();
        }
      } catch {
        await new Promise(resolve => setTimeout(resolve, 15_000));
      }
    }
  }
}
