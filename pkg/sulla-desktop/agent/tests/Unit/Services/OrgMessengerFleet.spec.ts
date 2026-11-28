// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { InMemoryOrgMessagingTransport, MessageAdmissionService, MessageEnvelope, ParticipantAddress, type ContactRequestChoice, type InboxCursor, type OrgMessagingTransport } from '@sulla/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInbox, type AgentInboxEntry, type AgentInboxRepository, type AgentInboxTarget } from '../../../services/AgentInbox';
import { OrgMembershipDirectory, OrgMembershipRequiredError, type OrgMembership, type OrgMembershipSource } from '../../../services/OrgMembershipDirectory';
import { OrgMessenger, type OrgContactPrompt, type OrgConversationStartRequest, type OrgMessagingSession } from '../../../services/OrgMessenger';
import { OrgMessengerFleet, type OrgFleetIdentity, type OrgMessengerFactory } from '../../../services/OrgMessengerFleet';
import { OrgHostingResolver, type OrgHostCredentials, type ServerOrgHostDirectory } from '../../../services/OrgHostingResolver';
import type { OrgMessagingStateRepository, PendingOrgMessage } from '../../../services/OrgMessagingStateRepository';

const ACME: OrgMembership = { orgId: 'org-a', name: 'Acme', slug: 'acme', memberCount: 2 };
const BETA: OrgMembership = { orgId: 'org-b', name: 'Beta', slug: 'beta', memberCount: 3 };

class MemoryState implements OrgMessagingStateRepository {
  readonly outbox = new Map<string, PendingOrgMessage>();
  readonly sent = new Set<string>();
  readonly cursors = new Map<string, number>();
  readonly askedAt = new Map<string, number>();
  async enqueue(message: PendingOrgMessage) { this.outbox.set(`${message.orgId}:${message.messageId}`, message); }
  async pending(orgId: string) { return [...this.outbox.values()].filter(item => item.orgId === orgId && !this.sent.has(`${item.orgId}:${item.messageId}`)); }
  async markSent(orgId: string, messageId: string) { this.sent.add(`${orgId}:${messageId}`); }
  async markFailed() {}
  async cursor(orgId: string, userId: string): Promise<InboxCursor> { return { orgId, userId, since: this.cursors.get(`${orgId}:${userId}`) ?? 0 }; }
  async advanceCursor(cursor: InboxCursor) { this.cursors.set(`${cursor.orgId}:${cursor.userId}`, cursor.since); }
  async lastContactPrompt(orgId: string, userId: string, senderUserId: string) { return this.askedAt.get(`${orgId}:${userId}:${senderUserId}`); }
  async recordContactPrompt(orgId: string, userId: string, senderUserId: string, at: number) { this.askedAt.set(`${orgId}:${userId}:${senderUserId}`, at); }
}

/**
 * Mirrors PostgresAgentInboxRepository: one row per local message id across every org,
 * and claim() leases only unleased rows for the target's channel and thread
 * (FOR UPDATE SKIP LOCKED), so concurrent flushes never hand out the same row twice.
 */
class MemoryInboxRepository implements AgentInboxRepository {
  private readonly entries = new Map<string, { entry: AgentInboxEntry; owner?: string }>();
  async enqueue(entry: AgentInboxEntry) { const id = entry.envelope.ids.messageId; if (this.entries.has(id)) return false; this.entries.set(id, { entry }); return true; }
  async claim(target: AgentInboxTarget, owner: string) {
    const rows = [...this.entries.values()].filter(row => !row.owner && row.entry.target.channel === target.channel
      && (!target.threadId || !row.entry.target.threadId || row.entry.target.threadId === target.threadId));
    for (const row of rows) row.owner = owner;
    return { owner, target, entries: rows.map(row => row.entry) };
  }
  async renew() {}
  async acknowledge(claim: { owner: string; entries: AgentInboxEntry[] }) { this.forOwned(claim, id => this.entries.delete(id)); }
  async acknowledgeIds(target: AgentInboxTarget, messageIds: string[]) { for (const id of messageIds) { const row = this.entries.get(id); if (row?.entry.target.channel === target.channel && row.entry.target.threadId === target.threadId) this.entries.delete(id); } }
  async release(claim: { owner: string; entries: AgentInboxEntry[] }) { this.forOwned(claim, id => { const row = this.entries.get(id); if (row) delete row.owner; }); }
  async pendingTargets() { return []; }
  private forOwned(claim: { owner: string; entries: AgentInboxEntry[] }, apply: (id: string) => void) {
    for (const entry of claim.entries) { const id = entry.envelope.ids.messageId; if (this.entries.get(id)?.owner === claim.owner) apply(id); }
  }
}

class MemoryMembershipSource implements OrgMembershipSource {
  constructor(public memberships: OrgMembership[]) {}
  async organizations() { return this.memberships; }
}

class TestIdentity implements OrgFleetIdentity {
  user = 'user-1';
  active = ACME.orgId;
  async userId() { return this.user; }
  async activeOrgId() { return this.active; }
}

/** Every org in these specs is Cloud-hosted: Desktop Accounts lists no Server orgs. */
class NoServerOrgs implements ServerOrgHostDirectory {
  async hosts() { return []; }
}

/** Cloud sign-in that follows the test identity, so signing out clears the user id. */
class IdentityCloudCredentials implements OrgHostCredentials {
  constructor(private readonly identity: TestIdentity) {}
  async accessToken() { return 'cloud-token'; }
  userId() { return this.identity.userId(); }
}

/** One Cloud host shared by every org; each transport is pinned to one org like the Cloud adapter. */
class PinnedOrgTransport implements OrgMessagingTransport {
  readonly hosting = 'cloud' as const;
  constructor(private readonly orgId: string, private readonly host: InMemoryOrgMessagingTransport) {}
  private guard(orgId: string) { if (orgId !== this.orgId) throw new Error(`transport for ${this.orgId} used for ${orgId}`); }
  async startConversation(request: OrgConversationStartRequest) { return { conversationId: request.conversationId }; }
  async submit(envelope: MessageEnvelope) { this.guard(envelope.data.orgId); return this.host.submit(envelope); }
  async contactRequests(orgId: string, userId: string) { this.guard(orgId); return this.host.contactRequests(orgId, userId); }
  async resolveContactRequest(orgId: string, userId: string, sender: string, choice: ContactRequestChoice) { this.guard(orgId); return this.host.resolveContactRequest(orgId, userId, sender, choice); }
  async pull(cursor: InboxCursor, limit: number) { this.guard(cursor.orgId); return this.host.pull(cursor, limit); }
  async ack() {}
  wakeups() { return this.host.wakeups(); }
  directory() { return { people: [{ userId: 'user-1' }, { userId: 'user-2', displayName: 'Dana' }] }; }
  async loadDirectory() { return this.directory(); }
  claimAgentHost(deviceId: string) { return this.host.claimAgentHost(deviceId); }
}

class ObservedMessenger extends OrgMessenger {
  signal?: AbortSignal;
  override run(signal: AbortSignal) { this.signal = signal; return super.run(signal); }
}

class TestFactory implements OrgMessengerFactory {
  readonly created = new Map<string, ObservedMessenger>();
  constructor(private readonly host: InMemoryOrgMessagingTransport, private readonly state: MemoryState, private readonly inbox: AgentInbox, private readonly prompts: OrgContactPrompt[]) {}
  create(membership: OrgMembership, session: OrgMessagingSession) {
    const messenger = new ObservedMessenger(
      new PinnedOrgTransport(membership.orgId, this.host), session, this.state, this.inbox,
      { target: async envelope => ({ channel: 'sulla-desktop', threadId: envelope.data.conversationId }) },
      { request: async prompt => { this.prompts.push(prompt); } },
      undefined,
      { deviceId: async() => 'device-1' },
    );
    this.created.set(membership.orgId, messenger);
    return messenger;
  }
}

function incoming(messageId: string, orgId: string, fromUserId = 'user-2'): MessageEnvelope {
  return MessageEnvelope.create({ messageId, conversationId: `conversation-${orgId}`, orgId,
    from: ParticipantAddress.agent(orgId, fromUserId, 'agent-2'), to: [ParticipantAddress.human(orgId, 'user-1')],
    kind: 'agent', intent: 'request', body: { text: `hello from ${orgId}`, format: 'plain', refs: [] },
    causality: { rootId: messageId, hop: 0, clientSeq: 1 }, provenance: { actingForUserId: fromUserId, placement: 'desktop' },
    createdAt: new Date(0).toISOString() });
}

function outgoing(messageId: string, orgId: string): MessageEnvelope {
  return MessageEnvelope.create({ messageId, conversationId: `out-${orgId}`, orgId,
    from: ParticipantAddress.agent(orgId, 'user-1', 'agent-1'), to: [ParticipantAddress.agent(orgId, 'user-2', 'agent-2')],
    kind: 'agent', intent: 'request', body: { text: 'ping', format: 'plain', refs: [] },
    causality: { rootId: messageId, hop: 0, clientSeq: 1 }, provenance: { actingForUserId: 'user-1', placement: 'desktop' },
    createdAt: new Date(0).toISOString() });
}

function setup(memberships: OrgMembership[] = [ACME, BETA], admission: (envelope: MessageEnvelope) => 'accepted' | 'held' = () => 'accepted') {
  const host = new InMemoryOrgMessagingTransport(new MessageAdmissionService(async envelope => admission(envelope)));
  const state = new MemoryState();
  const delivered: AgentInboxEntry[] = [];
  const inbox = new AgentInbox(new MemoryInboxRepository(), { isRunning: () => false, wake: async(_target, _batch, entries) => { delivered.push(...entries); return 'accepted'; } });
  const prompts: OrgContactPrompt[] = [];
  const factory = new TestFactory(host, state, inbox, prompts);
  const source = new MemoryMembershipSource(memberships);
  const identity = new TestIdentity();
  const hosting = new OrgHostingResolver(new NoServerOrgs(), { accessToken: async () => '' }, new IdentityCloudCredentials(identity), 'https://cloud.example.test');
  const fleet = new OrgMessengerFleet(new OrgMembershipDirectory(source), factory, identity, hosting);
  return { host, state, delivered, prompts, factory, source, identity, fleet };
}

const fleets: OrgMessengerFleet[] = [];
afterEach(() => { for (const fleet of fleets.splice(0)) fleet.stopAll(); });

describe('OrgMessengerFleet', () => {
  it('delivers two orgs independently, each advancing only its own cursor', async () => {
    // risk: data accuracy — messages in non-active orgs never arrive, or one org's cursor skips another's messages
    const { host, state, delivered, fleet } = setup();
    fleets.push(fleet);
    await host.submit(incoming('a-1', ACME.orgId));
    await host.submit(incoming('b-1', BETA.orgId));
    await host.submit(incoming('b-2', BETA.orgId));

    await fleet.reconcile();
    expect(fleet.syncingOrgIds().sort()).toEqual([ACME.orgId, BETA.orgId]);
    await vi.waitFor(() => {
      expect(state.cursors.get('org-a:user-1')).toBe(1);
      expect(state.cursors.get('org-b:user-1')).toBe(2);
    });
    const byOrg = (orgId: string) => delivered.filter(entry => entry.envelope.ids.orgId === orgId);
    expect(byOrg(ACME.orgId).map(entry => entry.envelope.ids.remoteMessageId)).toEqual(['a-1']);
    expect(byOrg(BETA.orgId).map(entry => entry.envelope.ids.remoteMessageId)).toEqual(['b-1', 'b-2']);
    expect(byOrg(ACME.orgId)[0].envelope.ids.orgName).toBe('Acme');
    expect(byOrg(BETA.orgId)[0].envelope.body.startsWith('[Beta] ')).toBe(true);

    // A new message in org B wakes only org B; org A's cursor does not move.
    await host.submit(incoming('b-3', BETA.orgId));
    await vi.waitFor(() => {
      fleet.onLiveEvent('conversations', BETA.orgId);
      expect(state.cursors.get('org-b:user-1')).toBe(3);
    });
    expect(state.cursors.get('org-a:user-1')).toBe(1);
    expect(byOrg(BETA.orgId).map(entry => entry.envelope.ids.remoteMessageId)).toEqual(['b-1', 'b-2', 'b-3']);
    expect(delivered).toHaveLength(4);
  });

  it('never prompts for a held contact request; same-org admission is handled by the host policy', async () => {
    const { host, delivered, prompts, fleet } = setup([ACME, BETA], envelope => envelope.data.orgId === BETA.orgId && envelope.data.from.userId === 'user-9' ? 'held' : 'accepted');
    fleets.push(fleet);
    await host.submit(incoming('held-b', BETA.orgId, 'user-9'));
    await fleet.reconcile();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(prompts).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('refuses to send to an org the human does not belong to, or with an envelope for another org', async () => {
    // risk: permissions/tenant isolation — an agent posts into an org the human is not a member of
    const { host, state, fleet } = setup();
    fleets.push(fleet);
    await fleet.reconcile();
    const before = host.count();

    await expect(fleet.send(outgoing('x-1', 'org-c'), 'org-c')).rejects.toBeInstanceOf(OrgMembershipRequiredError);
    await expect(fleet.send(outgoing('x-2', BETA.orgId), ACME.orgId)).rejects.toThrow('does not match');
    expect(host.count()).toBe(before);
    expect(state.outbox.size).toBe(0);

    // Member orgs work by name, and the default is the active org.
    await fleet.send(outgoing('ok-b', BETA.orgId), 'Beta');
    await fleet.send(outgoing('ok-a', ACME.orgId));
    expect([...state.sent].sort()).toEqual(['org-a:ok-a', 'org-b:ok-b']);
    expect(host.count()).toBe(before + 2);
  });

  it('uses a real member team when the legacy active org value is the user id', async () => {
    // risk: tenant isolation — the user's identity is never mistaken for a team id
    const { identity, fleet } = setup([ACME]);
    fleets.push(fleet);
    identity.active = identity.user;
    await expect(fleet.resolveOrg()).resolves.toEqual(ACME);
  });

  it('stops an org loop when the human leaves that org, never polls solo orgs, and stops everything on sign-out', async () => {
    // risk: data leak — Desktop keeps pulling an org's messages after the human left it or signed out
    const solo: OrgMembership = { orgId: 'org-solo', name: 'Just me', memberCount: 1 };
    const { source, identity, factory, fleet } = setup([ACME, BETA, solo]);
    fleets.push(fleet);
    await fleet.reconcile();
    expect(fleet.syncingOrgIds().sort()).toEqual([ACME.orgId, BETA.orgId]);
    const betaSignal = factory.created.get(BETA.orgId)?.signal;
    const acmeSignal = factory.created.get(ACME.orgId)?.signal;
    expect(betaSignal?.aborted).toBe(false);

    source.memberships = [ACME, solo];
    await fleet.reconcile();
    expect(fleet.syncingOrgIds()).toEqual([ACME.orgId]);
    expect(betaSignal?.aborted).toBe(true);
    expect(acmeSignal?.aborted).toBe(false);
    await expect(fleet.send(outgoing('after-leave', BETA.orgId), BETA.orgId)).rejects.toBeInstanceOf(OrgMembershipRequiredError);

    identity.user = '';
    await fleet.reconcile();
    expect(fleet.syncingOrgIds()).toEqual([]);
    expect(acmeSignal?.aborted).toBe(true);
  });

  it('keeps the same remote message id in two orgs as two separate inbox entries and outbox rows', async () => {
    // risk: data accuracy — one org's message is dropped as a duplicate of another org's message
    const { host, state, delivered, fleet } = setup();
    fleets.push(fleet);
    await host.submit(incoming('same-id', ACME.orgId));
    await host.submit(incoming('same-id', BETA.orgId));

    await fleet.reconcile();
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(delivered.map(entry => entry.envelope.ids.messageId).sort()).toEqual(['org:org-a:same-id', 'org:org-b:same-id']);
    expect(delivered.map(entry => entry.envelope.ids.remoteMessageId)).toEqual(['same-id', 'same-id']);

    await fleet.send(outgoing('same-out', ACME.orgId), ACME.orgId);
    await fleet.send(outgoing('same-out', BETA.orgId), BETA.orgId);
    expect([...state.outbox.keys()].sort()).toEqual(['org-a:same-out', 'org-b:same-out']);
    expect([...state.sent].sort()).toEqual(['org-a:same-out', 'org-b:same-out']);
  });
});
