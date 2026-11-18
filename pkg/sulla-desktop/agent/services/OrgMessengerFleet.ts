// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { MessageEnvelope } from '@sulla/domain';
import { OrgMembershipRequiredError, type OrgMembership, type OrgMembershipDirectory } from './OrgMembershipDirectory';
import type { OrgMessenger, OrgMessagingSession } from './OrgMessenger';
import { OrgHostingResolver, type OrgHosting, type OrgHostingSource } from './OrgHostingResolver';

/** Who is signed in, and which org the human has selected as active in Desktop. */
export interface OrgFleetIdentity {
  userId(): Promise<string>;
  activeOrgId(): Promise<string>;
}

/** Builds the OrgMessenger (with its own transport, cursor, outbox and host lease) for one org on its resolved host. */
export interface OrgMessengerFactory {
  create(membership: OrgMembership, session: OrgMessagingSession, hosting: OrgHosting): OrgMessenger;
}

/**
 * Session pinned to one member org; the org name follows the membership directory. The user id is the caller's id
 * on the org's host (the Cloud user id, or the Server subject).
 */
export class MemberOrgMessagingSession implements OrgMessagingSession {
  constructor(
    private readonly membership: OrgMembership,
    private readonly hosting: OrgHosting,
    private readonly directory: OrgMembershipDirectory,
  ) {}

  async orgId(): Promise<string> { return this.membership.orgId; }
  async userId(): Promise<string> { return this.hosting.credentials.userId(); }
  async orgName(): Promise<string> {
    return this.directory.list().find(org => org.orgId === this.membership.orgId)?.name ?? this.membership.name;
  }
}

/**
 * Runs one OrgMessenger per organization the signed-in human belongs to. Each org
 * keeps its own cursor, outbox, host lease and contact-prompt throttle (all keyed by
 * orgId in state). Each org's transport is built on the host its OrgHostingSource
 * resolves (Sulla Cloud by default, or the Sulla Server it lives on); an org whose
 * host cannot be resolved is skipped until a later refresh. Orgs with no other
 * member are not polled; leaving an org or signing out stops that org's loop.
 */
export class OrgMessengerFleet {
  private readonly messengers = new Map<string, OrgMessenger>();
  private readonly loops = new Map<string, AbortController>();
  private readonly hostings = new Map<string, OrgHosting>();
  private readonly creating = new Map<string, Promise<OrgMessenger | undefined>>();
  private signedInUserId = '';
  private fleetWake?: () => void;

  constructor(
    private readonly directory: OrgMembershipDirectory,
    private readonly factory: OrgMessengerFactory,
    private readonly identity: OrgFleetIdentity,
    private readonly hosting: OrgHostingSource = new OrgHostingResolver(),
    private readonly refreshMs = 60_000,
  ) {}

  /** Org ids whose sync loop is currently running. */
  syncingOrgIds(): string[] { return [...this.loops.keys()]; }

  /** Brings running loops in line with the human's current Cloud memberships. */
  async reconcile(): Promise<void> {
    const userId = await this.identity.userId();
    if (!userId) {
      this.stopAll();
      this.directory.clear();
      this.signedInUserId = '';
      return;
    }
    if (userId !== this.signedInUserId) {
      this.stopAll();
      this.signedInUserId = userId;
    }
    // A transport failure throws here and leaves the current loops untouched.
    const memberships = await this.directory.refresh();
    const current = new Set(memberships.map(org => org.orgId));
    for (const orgId of [...this.messengers.keys()]) {
      if (!current.has(orgId)) this.forget(orgId);
    }
    for (const membership of memberships) {
      if (membership.memberCount > 1) await this.start(membership);
      else this.stopLoop(membership.orgId);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        try {
          await this.reconcile();
        } catch (error) {
          console.warn('[OrgMessengerFleet] Could not refresh organization memberships:', error instanceof Error ? error.message : error);
        }
        await this.wait(signal, this.refreshMs);
      }
    } finally {
      this.stopAll();
    }
  }

  /**
   * Resolves the org a send targets: the requested org (id, slug or name) or the
   * active org. Refuses orgs the human does not belong to.
   */
  async resolveOrg(requested?: string): Promise<OrgMembership> {
    if (requested?.trim()) return this.directory.require(requested);
    const activeOrgId = await this.identity.activeOrgId();
    if (!activeOrgId) throw new Error('Organization messaging requires an active organization session');
    try {
      return await this.directory.require(activeOrgId);
    } catch (error) {
      if (error instanceof OrgMembershipRequiredError) throw error;
      // Cloud membership list unreachable: the active org is still the human's own selection.
      return { orgId: activeOrgId, name: activeOrgId, memberCount: 0 };
    }
  }

  /**
   * The target org and the caller's id on that org's host: the Cloud user id for a Cloud org, the Server subject
   * for a Server org. Envelopes for that org must be authored with this id.
   */
  async participant(requestedOrg?: string): Promise<{ membership: OrgMembership; userId: string }> {
    const membership = await this.resolveOrg(requestedOrg);
    await this.reachableMessenger(membership);
    const hosting = this.hostings.get(membership.orgId);
    if (!hosting) throw OrgMessengerFleet.unreachable(membership);
    return { membership, userId: await hosting.credentials.userId() };
  }

  /** People and agent addresses in the target org, read from the org's own host. */
  async loadDirectory(requestedOrg?: string): Promise<{ membership: OrgMembership; directory: { people: readonly unknown[] } }> {
    const membership = await this.resolveOrg(requestedOrg);
    return { membership, directory: await (await this.reachableMessenger(membership)).loadDirectory() };
  }

  /** Member-scoped inbox projection used by the Conversations renderer. */
  async loadInboxMessages(requestedOrg?: string): Promise<{ membership: OrgMembership; messages: readonly MessageEnvelope[] }> {
    const membership = await this.resolveOrg(requestedOrg);
    return { membership, messages: await (await this.reachableMessenger(membership)).loadInboxMessages() };
  }

  /** Refreshes and returns only the signed-in user's current member organizations. */
  async contactRequests(requestedOrg?: string): Promise<readonly MessageEnvelope['data'][]> {
    const membership = await this.resolveOrg(requestedOrg);
    const messenger = await this.reachableMessenger(membership);
    return messenger.listContactRequests();
  }

  async memberOrganizations(): Promise<readonly OrgMembership[]> {
    return this.directory.refresh();
  }

  async startConversation(request: { conversationId: string; kind: 'direct' | 'group' | 'agent_thread'; participantUserIds: readonly string[] }, requestedOrg?: string): Promise<{ membership: OrgMembership; conversationId: string }> {
    const membership = await this.resolveOrg(requestedOrg);
    const result = await (await this.reachableMessenger(membership)).startConversation(request);
    return { membership, conversationId: result.conversationId };
  }

  /** Sends through the target org's own messenger and outbox. The envelope must be authored for that org. */
  async send(envelope: MessageEnvelope, requestedOrg?: string): Promise<void> {
    const membership = await this.resolveOrg(requestedOrg);
    if (envelope.data.orgId !== membership.orgId) {
      throw new Error('Message organization does not match the organization it is being sent to');
    }
    await (await this.reachableMessenger(membership)).send(envelope);
  }

  /** LiveEvents hook: wakes one org (or all) on new conversation activity, and the fleet on membership changes. */
  onLiveEvent(topic: string, orgId?: string): void {
    if (topic === 'organizations') {
      this.fleetWake?.();
      return;
    }
    if (orgId) {
      this.messengers.get(orgId)?.onLiveEvent(topic);
      return;
    }
    for (const messenger of this.messengers.values()) messenger.onLiveEvent(topic);
  }

  /** Stops every org loop (sign-out or shutdown). */
  stopAll(): void {
    for (const orgId of [...this.messengers.keys()]) this.forget(orgId);
    for (const orgId of [...this.loops.keys()]) this.stopLoop(orgId);
  }

  private async reachableMessenger(membership: OrgMembership): Promise<OrgMessenger> {
    const messenger = await this.messengerFor(membership);
    if (!messenger) throw OrgMessengerFleet.unreachable(membership);
    return messenger;
  }

  private static unreachable(membership: OrgMembership): Error {
    return new Error(`Organization "${membership.name}" is not reachable right now; its host could not be resolved`);
  }

  /**
   * The org's messenger on its current host, or undefined when the host cannot be resolved. Re-resolves on every
   * call, so an org that moved between Cloud and a Server gets a fresh messenger (and loop) on the new host.
   */
  private messengerFor(membership: OrgMembership): Promise<OrgMessenger | undefined> {
    const inFlight = this.creating.get(membership.orgId);
    if (inFlight) return inFlight;
    const pending = this.buildMessenger(membership).finally(() => this.creating.delete(membership.orgId));
    this.creating.set(membership.orgId, pending);
    return pending;
  }

  private async buildMessenger(membership: OrgMembership): Promise<OrgMessenger | undefined> {
    let hosting: OrgHosting | undefined;
    try {
      hosting = await this.hosting.resolve(membership);
    } catch (error) {
      console.warn(`[OrgMessengerFleet] Could not resolve where organization ${membership.orgId} is hosted:`, error instanceof Error ? error.message : error);
    }
    if (!hosting) {
      this.forget(membership.orgId);
      return undefined;
    }
    const hostKey = `${hosting.kind}:${hosting.baseUrl}`;
    const existing = this.messengers.get(membership.orgId);
    const current = this.hostings.get(membership.orgId);
    if (existing && current && `${current.kind}:${current.baseUrl}` === hostKey) return existing;
    if (existing) this.forget(membership.orgId);
    const messenger = this.factory.create(membership, new MemberOrgMessagingSession(membership, hosting, this.directory), hosting);
    this.messengers.set(membership.orgId, messenger);
    this.hostings.set(membership.orgId, hosting);
    return messenger;
  }

  private async start(membership: OrgMembership): Promise<void> {
    const messenger = await this.messengerFor(membership);
    if (!messenger || this.loops.has(membership.orgId)) return;
    const controller = new AbortController();
    this.loops.set(membership.orgId, controller);
    messenger.run(controller.signal)
      .catch(error => console.warn(`[OrgMessengerFleet] Sync for organization ${membership.orgId} stopped unexpectedly:`, error))
      .finally(() => { if (this.loops.get(membership.orgId) === controller) this.loops.delete(membership.orgId); });
  }

  private stopLoop(orgId: string): void {
    const controller = this.loops.get(orgId);
    if (!controller) return;
    this.loops.delete(orgId);
    controller.abort();
  }

  private forget(orgId: string): void {
    this.stopLoop(orgId);
    this.messengers.delete(orgId);
    this.hostings.delete(orgId);
  }

  private wait(signal: AbortSignal, milliseconds: number): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = () => done();
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); if (this.fleetWake === done) this.fleetWake = undefined; resolve(); };
      this.fleetWake = done;
      timer = setTimeout(done, milliseconds);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
