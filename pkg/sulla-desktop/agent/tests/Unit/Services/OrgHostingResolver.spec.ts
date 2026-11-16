// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { InboxCursor } from '@sulla/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInbox } from '../../../services/AgentInbox';
import { DesktopOrgMessengerFactory } from '../../../services/DesktopOrgMessengerFactory';
import { OrgMembershipDirectory, type OrgMembership, type OrgMembershipSource } from '../../../services/OrgMembershipDirectory';
import { OrgHostingResolver, type OrgHostCredentials, type OrgHosting, type ServerAccessTokenSource, type ServerOrgHost, type ServerOrgHostDirectory } from '../../../services/OrgHostingResolver';
import { OrgMessenger, type OrgMessagingSession } from '../../../services/OrgMessenger';
import { OrgMessengerFleet, type OrgFleetIdentity, type OrgMessengerFactory } from '../../../services/OrgMessengerFleet';
import type { OrgMessagingStateRepository, PendingOrgMessage } from '../../../services/OrgMessagingStateRepository';

const CLOUD_BASE = 'https://cloud.example.test';
const CLOUD_ORG: OrgMembership = { orgId: 'org-cloud', name: 'Cloud Co', memberCount: 2 };
const SERVER_ORG: OrgMembership = { orgId: 'org-server', name: 'Server Co', memberCount: 2 };
const SERVER_HOST: ServerOrgHost = { orgId: SERVER_ORG.orgId, authorityId: 'auth-1', issuer: 'https://sulla.acme.test/oidc', subject: 'server-subject-7' };

class CloudCredentials implements OrgHostCredentials {
  user = 'cloud-user-1';
  async accessToken() { return 'cloud-token'; }
  async userId() { return this.user; }
}

class MemoryServerHosts implements ServerOrgHostDirectory {
  failure?: Error;
  constructor(public list: ServerOrgHost[] = [SERVER_HOST]) {}
  async hosts() { if (this.failure) throw this.failure; return this.list; }
}

class MemoryServerTokens implements ServerAccessTokenSource {
  token = 'server-token';
  failure?: Error;
  readonly asked: string[] = [];
  async accessToken(host: ServerOrgHost) { this.asked.push(host.orgId); if (this.failure) throw this.failure; return this.token; }
}

class RecordingLogger {
  readonly lines: string[] = [];
  warn(message: string) { this.lines.push(message); }
}

class MemoryState implements OrgMessagingStateRepository {
  readonly cursors = new Map<string, number>();
  async enqueue(_message: PendingOrgMessage) {}
  async pending() { return []; }
  async markSent() {}
  async markFailed() {}
  async cursor(orgId: string, userId: string): Promise<InboxCursor> { return { orgId, userId, since: this.cursors.get(`${orgId}:${userId}`) ?? 0 }; }
  async advanceCursor(cursor: InboxCursor) { this.cursors.set(`${cursor.orgId}:${cursor.userId}`, cursor.since); }
  async lastContactPrompt() { return undefined; }
  async recordContactPrompt() {}
}

/** Stands in for the network: records every request URL and bearer, answers an empty inbox page. */
class RecordingNetwork {
  readonly requests: { url: string; authorization: string | null }[] = [];
  readonly fetch = vi.fn(async (input: string, init: RequestInit) => {
    this.requests.push({ url: input, authorization: new Headers(init.headers).get('Authorization') });
    return new Response(JSON.stringify({ messages: [], next: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

function setup() {
  const cloud = new CloudCredentials();
  const hosts = new MemoryServerHosts();
  const tokens = new MemoryServerTokens();
  const logger = new RecordingLogger();
  const resolver = new OrgHostingResolver(hosts, tokens, cloud, CLOUD_BASE, logger);
  return { cloud, hosts, tokens, logger, resolver };
}

/** Builds the production messenger for an org on its resolved host, then pulls its inbox once. */
async function pullThroughFactory(membership: OrgMembership, hosting: OrgHosting) {
  const network = new RecordingNetwork();
  vi.stubGlobal('fetch', network.fetch);
  const state = new MemoryState();
  const factory = new DesktopOrgMessengerFactory(state, {} as AgentInbox, { target: async () => ({ channel: 'sulla-desktop' }) }, { request: async () => {} });
  const session: OrgMessagingSession = { orgId: async () => membership.orgId, userId: () => hosting.credentials.userId(), orgName: async () => membership.name };
  await factory.create(membership, session, hosting).pullInbox();
  return { network, state };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('OrgHostingResolver', () => {
  it('routes an org Desktop Accounts does not list under a Server to Sulla Cloud with the Cloud token', async () => {
    // risk: data accuracy — a Cloud org's conversations are read from the wrong host
    const { resolver, tokens } = setup();
    const hosting = await resolver.resolve(CLOUD_ORG);
    expect(hosting?.kind).toBe('cloud');
    expect(hosting?.baseUrl).toBe(CLOUD_BASE);
    expect(tokens.asked).toEqual([]);

    const { network } = await pullThroughFactory(CLOUD_ORG, hosting!);
    expect(network.requests).toEqual([{ url: `${CLOUD_BASE}/orgs/org-cloud/inbox?since=0&limit=50`, authorization: 'Bearer cloud-token' }]);
  });

  it('routes a Server-hosted org to its Server origin with the Server token and the Server subject, never to Cloud', async () => {
    // risk: tenant isolation — a Server org's messages go to (or are read from) Sulla Cloud, or with the Cloud identity
    const { resolver } = setup();
    const hosting = await resolver.resolve(SERVER_ORG);
    expect(hosting?.kind).toBe('server');
    expect(hosting?.baseUrl).toBe('https://sulla.acme.test');
    expect(await hosting?.credentials.userId()).toBe('server-subject-7');

    const { network, state } = await pullThroughFactory(SERVER_ORG, hosting!);
    expect(network.requests).toEqual([{ url: 'https://sulla.acme.test/orgs/org-server/inbox?since=0&limit=50', authorization: 'Bearer server-token' }]);
    expect(network.requests.some(request => request.url.startsWith(CLOUD_BASE))).toBe(false);
    // The cursor is keyed by the person's id on that Server, not their Cloud id.
    expect(await state.cursor(SERVER_ORG.orgId, 'server-subject-7')).toEqual({ orgId: SERVER_ORG.orgId, userId: 'server-subject-7', since: 0 });
  });

  it('skips a Server org that is unreachable, has no token, or has no usable address, and logs each reason once', async () => {
    // risk: data leak / crash — an unresolvable Server org falls back to Cloud, throws, or floods the log every minute
    const { resolver, tokens, hosts, logger } = setup();

    tokens.failure = new Error('connect ECONNREFUSED');
    expect(await resolver.resolve(SERVER_ORG)).toBeUndefined();
    expect(await resolver.resolve(SERVER_ORG)).toBeUndefined();
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain('Skipping organization "Server Co" (org-server)');
    expect(logger.lines[0]).toContain('unreachable (connect ECONNREFUSED)');

    tokens.failure = undefined;
    tokens.token = '';
    expect(await resolver.resolve(SERVER_ORG)).toBeUndefined();
    expect(logger.lines[1]).toContain('no access token for the Sulla Server at https://sulla.acme.test');

    hosts.list = [{ ...SERVER_HOST, issuer: 'ftp://sulla.acme.test' }];
    expect(await resolver.resolve(SERVER_ORG)).toBeUndefined();
    expect(logger.lines[2]).toContain('no usable address');
    expect(logger.lines).toHaveLength(3);

    // Once the token is back, the org resolves to its Server again.
    hosts.list = [SERVER_HOST];
    tokens.token = 'server-token';
    expect((await resolver.resolve(SERVER_ORG))?.kind).toBe('server');
  });

  it('keeps routing a known Server org to its Server when Desktop Accounts cannot be read', async () => {
    // risk: tenant isolation — an Accounts outage silently reroutes a Server org's messages through Cloud
    const { resolver, hosts, logger } = setup();
    expect((await resolver.resolve(SERVER_ORG))?.kind).toBe('server');

    hosts.failure = new Error('accounts_unavailable');
    expect((await resolver.resolve(SERVER_ORG))?.baseUrl).toBe('https://sulla.acme.test');
    expect((await resolver.resolve(SERVER_ORG))?.kind).toBe('server');
    expect(logger.lines).toEqual(['[OrgHostingResolver] Could not read Sulla Server organizations (accounts_unavailable); using the last known list.']);
  });
});

class StaticMembershipSource implements OrgMembershipSource {
  constructor(public memberships: OrgMembership[]) {}
  async organizations() { return this.memberships; }
}

/** Records which host each org's messenger was built for; its loop just waits for abort. */
class HostRecordingFactory implements OrgMessengerFactory {
  readonly built: { orgId: string; kind: string; baseUrl: string }[] = [];
  create(membership: OrgMembership, _session: OrgMessagingSession, hosting: OrgHosting): OrgMessenger {
    this.built.push({ orgId: membership.orgId, kind: hosting.kind, baseUrl: hosting.baseUrl });
    const messenger = Object.create(OrgMessenger.prototype) as OrgMessenger;
    messenger.run = (signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return messenger;
  }
}

describe('OrgMessengerFleet with OrgHostingResolver', () => {
  const identity: OrgFleetIdentity = { userId: async () => 'cloud-user-1', activeOrgId: async () => CLOUD_ORG.orgId };

  it('runs the Cloud org, skips an unreachable Server org without failing, and starts it on its Server once reachable', async () => {
    // risk: availability — one broken Server org stops every other org from syncing
    const { resolver, tokens } = setup();
    const factory = new HostRecordingFactory();
    const fleet = new OrgMessengerFleet(new OrgMembershipDirectory(new StaticMembershipSource([CLOUD_ORG, SERVER_ORG])), factory, identity, resolver);
    try {
      tokens.failure = new Error('timeout');
      await expect(fleet.reconcile()).resolves.toBeUndefined();
      expect(fleet.syncingOrgIds()).toEqual([CLOUD_ORG.orgId]);
      expect(factory.built).toEqual([{ orgId: CLOUD_ORG.orgId, kind: 'cloud', baseUrl: CLOUD_BASE }]);
      await expect(fleet.send({ data: { orgId: SERVER_ORG.orgId } } as never, SERVER_ORG.orgId)).rejects.toThrow('not reachable right now');

      tokens.failure = undefined;
      await fleet.reconcile();
      expect(fleet.syncingOrgIds().sort()).toEqual([CLOUD_ORG.orgId, SERVER_ORG.orgId]);
      expect(factory.built).toEqual([
        { orgId: CLOUD_ORG.orgId, kind: 'cloud', baseUrl: CLOUD_BASE },
        { orgId: SERVER_ORG.orgId, kind: 'server', baseUrl: 'https://sulla.acme.test' },
      ]);
    } finally {
      fleet.stopAll();
    }
  });

  it('rebuilds an org messenger on the new host when the org moves from Cloud to a Server', async () => {
    // risk: data accuracy — after a move, Desktop keeps polling the old host and misses the org's messages
    const { resolver, hosts } = setup();
    hosts.list = [];
    const factory = new HostRecordingFactory();
    const fleet = new OrgMessengerFleet(new OrgMembershipDirectory(new StaticMembershipSource([SERVER_ORG])), factory, identity, resolver);
    try {
      await fleet.reconcile();
      expect(factory.built).toEqual([{ orgId: SERVER_ORG.orgId, kind: 'cloud', baseUrl: CLOUD_BASE }]);

      hosts.list = [SERVER_HOST];
      await fleet.reconcile();
      await fleet.reconcile();
      expect(factory.built).toEqual([
        { orgId: SERVER_ORG.orgId, kind: 'cloud', baseUrl: CLOUD_BASE },
        { orgId: SERVER_ORG.orgId, kind: 'server', baseUrl: 'https://sulla.acme.test' },
      ]);
      expect(fleet.syncingOrgIds()).toEqual([SERVER_ORG.orgId]);
    } finally {
      fleet.stopAll();
    }
  });
});
