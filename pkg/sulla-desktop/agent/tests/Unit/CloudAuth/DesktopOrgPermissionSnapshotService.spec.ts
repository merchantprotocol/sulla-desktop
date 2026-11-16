// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Desktop's offline org permissions: Cloud's signed PermissionSnapshot is verified with the domain
// SnapshotVerifier and answers can() through Authorizer + SnapshotFacts. Real Ed25519 signing (domain
// SnapshotSigner), a fake Cloud transport, the in-memory store and a real temp-dir file store.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AREA_KEYS, Bytes, NobleCryptoPrimitives, Resources, SnapshotSigner,
  type Level, type PermissionSnapshot, type UserPrincipal,
} from '@sulla/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { DesktopOrgPermissionSnapshotService } from '../../../../main/cloud/orgPermissions/DesktopOrgPermissionSnapshotService';
import { FileOrgPermissionSnapshotStore, MemoryOrgPermissionSnapshotStore } from '../../../../main/cloud/orgPermissions/OrgPermissionSnapshotStore';
import {
  CloudOrgPermissionSnapshotTransport,
  type OrgPermissionSnapshotTransport,
  type PublishedSnapshotKey,
  type SnapshotFetchResult,
} from '../../../../main/cloud/orgPermissions/OrgPermissionSnapshotTransport';

const crypto = new NobleCryptoPrimitives();
const ORG = 'org-1';
const USER = 'user-1';
const T0 = new Date('2026-11-16T12:00:00Z');
const DAY = 86_400_000;

class MutableClock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value) }
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms) }
}

class CloudKey {
  readonly seed: Uint8Array;
  constructor(readonly keyId: string, fill: number) {
    this.seed = new Uint8Array(32).fill(fill);
  }

  published(activeFrom = '2026-01-01T00:00:00Z', retiredAt: string | null = null): PublishedSnapshotKey {
    return { keyId: this.keyId, publicKey: Bytes.toBase64Url(crypto.ed25519PublicKey(this.seed)), activeFrom, retiredAt };
  }

  sign(overrides: Partial<Omit<PermissionSnapshot, 'sig' | 'keyId'>> = {}): string {
    const levels = Object.fromEntries(AREA_KEYS.map((a) => [a, 'none'])) as Record<(typeof AREA_KEYS)[number], Level>;
    levels.files = 'view';
    levels.people = 'view';
    const body = {
      v: 1 as const, orgId: ORG, userId: USER,
      issuedAt: T0.toISOString(), notAfter: new Date(T0.getTime() + 7 * DAY).toISOString(),
      epoch: 100, status: 'active' as const,
      // An org custom role (presets are resolved by id; a custom role carries its own levels).
      role: { id: 'role-custom', key: 'custom', name: 'Viewer plus', preset: false, orgId: ORG, basedOn: 'viewer' },
      roleVersion: 1, levels, areaOverrides: {}, groups: [], groupLevels: {}, agentCaps: {}, grants: [],
      revokedDevices: [],
      ...overrides,
    };

    return JSON.stringify(new SnapshotSigner(crypto, this.keyId, this.seed).sign(body));
  }
}

/** Plays Cloud: answers in the order queued; counts calls. */
class FakeCloud implements OrgPermissionSnapshotTransport {
  snapshots: SnapshotFetchResult[] = [];
  keys: PublishedSnapshotKey[] | null = [];
  snapshotCalls = 0;
  keyCalls = 0;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  hold(): void { this.gate = new Promise((resolve) => { this.release = resolve }) }
  open(): void { this.release?.(); this.gate = null }

  async fetchSnapshot(): Promise<SnapshotFetchResult> {
    this.snapshotCalls++;
    if (this.gate) await this.gate;

    return this.snapshots.length > 1 ? this.snapshots.shift()! : this.snapshots[0] ?? { kind: 'unavailable', detail: 'offline' };
  }

  async fetchKeys(): Promise<PublishedSnapshotKey[] | null> {
    this.keyCalls++;

    return this.keys;
  }
}

const member: UserPrincipal = { kind: 'user', userId: USER, orgId: ORG, sessionId: 's1', authStrength: 'password' };
const orgResource = Resources.org(ORG);

function setup(options: { deviceId?: string; pinned?: CloudKey } = {}) {
  const key = new CloudKey('k1', 7);
  const cloud = new FakeCloud();
  cloud.keys = [key.published()];
  const store = new MemoryOrgPermissionSnapshotStore();
  const clock = new MutableClock(T0);
  const service = new DesktopOrgPermissionSnapshotService({
    transport: cloud, store, clock,
    deviceId:  () => options.deviceId ?? null,
    pinnedKeys: options.pinned ? [{
      keyId: options.pinned.keyId, publicKey: crypto.ed25519PublicKey(options.pinned.seed), activeFrom: new Date('2026-01-01T00:00:00Z'), retiredAt: null,
    }] : undefined,
  });

  return { key, cloud, store, clock, service };
}

describe('DesktopOrgPermissionSnapshotService: online refresh', () => {
  // risk: permissions — only a snapshot Cloud really signed for this member may be trusted offline.
  it('fetches keys on first use, verifies and caches a Cloud-signed snapshot', async () => {
    const { key, cloud, store, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];

    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'refreshed', epoch: 100 });
    expect(cloud.keyCalls).toBe(1);
    expect(store.entry(ORG, USER).snapshot?.text).toBe(key.sign());
    expect(service.load({ orgId: ORG, userId: USER }).kind).toBe('verified');
  });

  it('refuses a tampered snapshot and stores nothing', async () => {
    const { key, cloud, store, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign().replace('"files":"view"', '"files":"manage"') }];

    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'rejected', reason: 'bad_signature' });
    expect(store.entry(ORG, USER).snapshot).toBeNull();
  });

  it("refuses a snapshot signed for someone else or another org", async () => {
    const { key, cloud, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign({ userId: 'user-2' }) }];
    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'rejected', reason: 'wrong_subject' });
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign({ orgId: 'org-2' }) }];
    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'rejected', reason: 'wrong_subject' });
  });

  it('refuses a snapshot signed by a key Cloud never published', async () => {
    const { cloud, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: new CloudKey('k-rogue', 9).sign() }];

    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'rejected', reason: 'unknown_key' });
  });

  it('picks up a rotated key by re-fetching the published keys once', async () => {
    const { cloud, service } = setup();
    const rotated = new CloudKey('k2', 8);
    cloud.snapshots = [{ kind: 'snapshot', text: new CloudKey('k1', 7).sign() }];
    expect((await service.refresh({ orgId: ORG, userId: USER })).kind).toBe('refreshed'); // caches k1 only
    cloud.keys = [new CloudKey('k1', 7).published(), rotated.published()];
    cloud.snapshots = [{ kind: 'snapshot', text: rotated.sign() }];
    cloud.keyCalls = 0;

    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'refreshed', epoch: 100 });
    expect(cloud.keyCalls).toBe(1);
  });

  it('with pinned keys, ignores the published list entirely', async () => {
    const pinned = new CloudKey('k-pinned', 3);
    const { key, cloud, service } = setup({ pinned });
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];
    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'rejected', reason: 'unknown_key' });
    expect(cloud.keyCalls).toBe(0);

    cloud.snapshots = [{ kind: 'snapshot', text: pinned.sign() }];
    expect((await service.refresh({ orgId: ORG, userId: USER })).kind).toBe('refreshed');
  });

  it('refuses an older epoch than one already accepted (rollback)', async () => {
    const { key, cloud, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign({ epoch: 200 }) }];
    await service.refresh({ orgId: ORG, userId: USER });
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign({ epoch: 150 }) }];

    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'rejected', reason: 'rolled_back' });
  });

  it('drops the cache when Cloud says the member left or the device was revoked, but keeps the epoch floor', async () => {
    for (const revoked of ['not_member', 'device_revoked'] as const) {
      const { key, cloud, store, service } = setup();
      cloud.snapshots = [{ kind: 'snapshot', text: key.sign({ epoch: 300 }) }];
      await service.refresh({ orgId: ORG, userId: USER });
      cloud.snapshots = [{ kind: revoked }];

      expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'revoked', reason: revoked });
      expect(store.entry(ORG, USER)).toEqual({ snapshot: null, highWaterEpoch: 300 });
      expect((await service.can(member, 'people.list', orgResource)).allowed).toBe(false);
    }
  });

  it('keeps the cached snapshot when Cloud is unreachable', async () => {
    const { key, cloud, store, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];
    await service.refresh({ orgId: ORG, userId: USER });
    cloud.snapshots = [{ kind: 'unavailable', detail: 'offline' }];

    expect(await service.refresh({ orgId: ORG, userId: USER })).toEqual({ kind: 'offline', detail: 'offline' });
    expect(store.entry(ORG, USER).snapshot).not.toBeNull();
  });

  it('shares one Cloud request between concurrent refreshes for the same member', async () => {
    const { key, cloud, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];
    cloud.hold();
    const both = Promise.all([service.refresh({ orgId: ORG, userId: USER }), service.refresh({ orgId: ORG, userId: USER })]);
    cloud.open();

    expect((await both).map((r) => r.kind)).toEqual(['refreshed', 'refreshed']);
    expect(cloud.snapshotCalls).toBe(1);
  });
});

describe('DesktopOrgPermissionSnapshotService: offline decisions', () => {
  // risk: permissions — offline answers must match the member's signed role and never exceed it.
  it("answers can() from the verified snapshot: a People viewer may list people but can't invite", async () => {
    const { key, cloud, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];
    await service.refresh({ orgId: ORG, userId: USER });
    cloud.snapshots = [{ kind: 'unavailable', detail: 'offline' }];

    expect((await service.can(member, 'people.list', orgResource)).allowed).toBe(true);
    const invite = await service.can(member, 'people.invite', orgResource);
    expect(invite.allowed).toBe(false);
    expect(invite.reason).toBe('insufficient_level');
  });

  it('denies other orgs and other users (no snapshot for them)', async () => {
    const { key, cloud, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];
    await service.refresh({ orgId: ORG, userId: USER });
    cloud.snapshots = [{ kind: 'unavailable', detail: 'offline' }];

    const otherOrg = await service.can({ ...member, orgId: 'org-2' }, 'people.list', Resources.org('org-2'));
    expect(otherOrg).toMatchObject({ allowed: false, requiresLiveCheck: true });
    expect((await service.can({ ...member, userId: 'user-2' }, 'people.list', orgResource)).allowed).toBe(false);
  });

  it('with no snapshot and no Cloud, denies and asks for a live check', async () => {
    const { service } = setup();

    expect(await service.can(member, 'people.list', orgResource)).toMatchObject({
      allowed: false, reason: 'stale_snapshot', requiresLiveCheck: true,
    });
  });

  it('refuses sensitive verbs after 24 h and everything after the snapshot expires', async () => {
    const { key, cloud, clock, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign({ levels: { ...JSON.parse(key.sign()).levels, files: 'manage' } }) }];
    await service.refresh({ orgId: ORG, userId: USER });
    cloud.snapshots = [{ kind: 'unavailable', detail: 'offline' }];

    expect((await service.can(member, 'files.share', orgResource)).allowed).toBe(true);
    clock.advance(DAY + 60_000);
    expect(await service.can(member, 'files.share', orgResource)).toMatchObject({ allowed: false, reason: 'stale_snapshot' });
    expect((await service.can(member, 'files.read', orgResource)).allowed).toBe(true);
    clock.advance(7 * DAY);
    expect((await service.can(member, 'files.read', orgResource)).allowed).toBe(false);
  });

  it('re-verifies the cached text on every use, so a tampered cache is refused', async () => {
    const { key, cloud, store, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];
    await service.refresh({ orgId: ORG, userId: USER });
    cloud.snapshots = [{ kind: 'unavailable', detail: 'offline' }];
    const cached = store.entry(ORG, USER).snapshot!;
    store.saveSnapshot(ORG, USER, { ...cached, text: cached.text.replace('"people":"view"', '"people":"manage"') }, 0);

    expect(service.load({ orgId: ORG, userId: USER })).toEqual({ kind: 'invalid', reason: 'bad_signature' });
    expect((await service.can(member, 'people.invite', orgResource)).allowed).toBe(false);
  });

  it('denies every decision when the snapshot lists this device as revoked', async () => {
    const { key, cloud, service } = setup({ deviceId: 'dev-1' });
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign({ revokedDevices: ['dev-1'] }) }];
    await service.refresh({ orgId: ORG, userId: USER });

    expect(await service.can(member, 'people.list', orgResource)).toMatchObject({ allowed: false, reason: 'scope_not_allowed' });
  });

  it('agents ride on their human and never exceed them', async () => {
    const { key, cloud, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];
    await service.refresh({ orgId: ORG, userId: USER });
    const agent = { kind: 'agent' as const, agentId: 'a1', actingFor: member, runId: 'r1', placement: 'desktop' as const };

    expect((await service.can(agent, 'people.list', orgResource)).allowed).toBe(true);
    expect((await service.can(agent, 'people.invite', orgResource)).allowed).toBe(false);
  });

  it('refreshes a cache older than refreshAfterMs before deciding, and not before', async () => {
    const { key, cloud, clock, service } = setup();
    cloud.snapshots = [{ kind: 'snapshot', text: key.sign() }];
    await service.can(member, 'people.list', orgResource);
    expect(cloud.snapshotCalls).toBe(1);
    await service.can(member, 'people.list', orgResource);
    expect(cloud.snapshotCalls).toBe(1);
    clock.advance(DesktopOrgPermissionSnapshotService.DEFAULT_REFRESH_AFTER_MS);
    await service.can(member, 'people.list', orgResource);
    expect(cloud.snapshotCalls).toBe(2);
  });

  it('platform principals are never answered offline', async () => {
    const { service } = setup();

    expect((await service.can({ kind: 'platform', userId: USER }, 'people.list', orgResource)).allowed).toBe(false);
  });
});

describe('FileOrgPermissionSnapshotStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // risk: permissions — the epoch floor must survive dropping a snapshot and a restart.
  it('persists snapshots, keys and the epoch floor across instances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-snap-'));
    dirs.push(dir);
    const first = FileOrgPermissionSnapshotStore.in(() => dir);
    first.saveKeys([new CloudKey('k1', 7).published()]);
    first.saveSnapshot(ORG, USER, { text: 'x', fetchedAt: T0.toISOString() }, 42);
    first.dropSnapshot(ORG, USER);

    const second = FileOrgPermissionSnapshotStore.in(() => dir);
    expect(second.entry(ORG, USER)).toEqual({ snapshot: null, highWaterEpoch: 42 });
    expect(second.keys().map((k) => k.keyId)).toEqual(['k1']);
    expect(second.entry('org-2', USER)).toEqual({ snapshot: null, highWaterEpoch: 0 });
  });

  it('never lowers the epoch floor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-snap-'));
    dirs.push(dir);
    const store = FileOrgPermissionSnapshotStore.in(() => dir);
    store.saveSnapshot(ORG, USER, { text: 'a', fetchedAt: T0.toISOString() }, 50);
    store.saveSnapshot(ORG, USER, { text: 'b', fetchedAt: T0.toISOString() }, 10);

    expect(store.entry(ORG, USER).highWaterEpoch).toBe(50);
  });
});

describe('CloudOrgPermissionSnapshotTransport', () => {
  // risk: permissions — misreading Cloud's answer would keep a leaver's offline access or drop a member's.
  const transport = (status: number, body: string, calls: string[] = []) => new CloudOrgPermissionSnapshotTransport(async(_m, p) => {
    calls.push(p);

    return new Response(body, { status });
  });

  it('asks for the org by ?team= and returns the exact text on 200', async () => {
    const calls: string[] = [];
    expect(await transport(200, '{"v":1}', calls).fetchSnapshot('org/1')).toEqual({ kind: 'snapshot', text: '{"v":1}' });
    expect(calls).toEqual(['/authz/snapshot?team=org%2F1']);
  });

  it('maps 404 to not_member and 403 device_revoked to device_revoked', async () => {
    expect(await transport(404, '{"error":"not_found"}').fetchSnapshot(ORG)).toEqual({ kind: 'not_member' });
    expect(await transport(403, '{"error":"forbidden","reason":"device_revoked"}').fetchSnapshot(ORG)).toEqual({ kind: 'device_revoked' });
  });

  it('treats 401, 403 without device_revoked, 503 and network errors as unavailable (keep cache)', async () => {
    expect((await transport(401, '{}').fetchSnapshot(ORG)).kind).toBe('unavailable');
    expect((await transport(403, '{"error":"forbidden"}').fetchSnapshot(ORG)).kind).toBe('unavailable');
    expect((await transport(503, '{"error":"snapshot_unavailable"}').fetchSnapshot(ORG)).kind).toBe('unavailable');
    const failing = new CloudOrgPermissionSnapshotTransport(async() => { throw new Error('Not signed in to Sulla Cloud') });
    expect(await failing.fetchSnapshot(ORG)).toEqual({ kind: 'unavailable', detail: 'Not signed in to Sulla Cloud' });
  });

  it('reads only well-formed published keys', async () => {
    const good = new CloudKey('k1', 7).published();
    const keys = await transport(200, JSON.stringify({ keys: [good, { keyId: 'bad' }] })).fetchKeys();
    expect(keys).toEqual([good]);
    expect(await transport(500, '{}').fetchKeys()).toBeNull();
  });
});
