// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { InProcessRefreshLock, type PendingRevocationQueue } from '@sulla/domain';
import { describe, expect, it } from 'vitest';

import { LegacyCloudSessionRefresher, PendingCloudSessionRefresher } from '@pkg/main/cloud/session/DesktopCloudSessionRefreshers';
import { DesktopCloudSignOut } from '@pkg/main/cloud/session/DesktopCloudSignOut';
import {
  type CloudSessionStorage, LegacySignOutTokenStore, LegacyTokenStore, type StoredCloudSession,
} from '@pkg/main/cloud/session/DesktopTokenStores';
import {
  type CloudLogoutHttp, type CloudRefreshHttp, ElectronCloudRefreshTransport, FetchCloudLogoutHttp,
} from '@pkg/main/cloud/session/ElectronCloudRefreshTransport';

const jwt = (secondsLeft: number, tag: string) => {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${ part({ alg: 'HS256' }) }.${ part({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + secondsLeft, tag }) }.sig`;
};

class MemoryStorage implements CloudSessionStorage<StoredCloudSession> {
  session: StoredCloudSession | null;
  writes = 0;
  clearFails = false;
  constructor(session: StoredCloudSession | null, private readonly log: string[] = []) { this.session = session; }
  async load() { return this.session ? { ...this.session, tokens: { ...this.session.tokens } } : null; }
  async save(session: StoredCloudSession) { this.writes += 1; this.session = session; }
  async clear() {
    if (this.clearFails) throw new Error('vault unavailable');
    this.log.push('clear');
    this.session = null;
  }
}

class FakeCloud implements CloudRefreshHttp {
  calls: string[] = [];
  behaviour: 'ok' | number | 'network' = 'ok';
  gate: Promise<void> | null = null;
  private rotations = 0;
  async post(refreshToken: string) {
    this.calls.push(refreshToken);
    if (this.gate) await this.gate;
    if (this.behaviour === 'network') throw Object.assign(new Error('ECONNREFUSED'), { status: 403 });
    if (typeof this.behaviour === 'number') return { status: this.behaviour, body: null };
    this.rotations += 1;
    return { status: 200, body: { accessToken: jwt(900, `new${ this.rotations }`), refreshToken: `rt-${ this.rotations + 1 }` } };
  }
}

class Reporter {
  failures: string[] = [];
  refreshes = 0;
  failed(message: string) { this.failures.push(message); }
  refreshed() { this.refreshes += 1; }
}

const expiring = (): StoredCloudSession => ({
  userId: 'user-1', activeContractorId: 'user-1', contractors: [],
  tokens: { accessToken: jwt(10, 'old'), refreshToken: 'rt-1' },
});

/** Sulla Cloud /auth/logout. Records every POST in the shared log so tests can check it follows the local clear. */
class FakeLogout implements CloudLogoutHttp {
  calls: string[] = [];
  behaviour: number | 'network' = 200;
  constructor(private readonly log: string[]) {}
  async post(refreshToken: string) {
    this.calls.push(refreshToken);
    this.log.push(`logout:${ refreshToken }`);
    if (this.behaviour === 'network') throw new Error('ECONNREFUSED');
    return { status: this.behaviour };
  }
}

class SpyRevocations implements PendingRevocationQueue {
  pushed: string[] = [];
  async push(refreshToken: string) { this.pushed.push(refreshToken); }
  async drain() { return [...this.pushed]; }
  async remove(refreshToken: string) { this.pushed = this.pushed.filter(t => t !== refreshToken); }
}

const rig = (session: StoredCloudSession | null = expiring(), revocations?: PendingRevocationQueue) => {
  const log: string[] = [];
  const storage = new MemoryStorage(session, log);
  const cloud = new FakeCloud();
  const reporter = new Reporter();
  const logout = new FakeLogout(log);
  const refresher = new LegacyCloudSessionRefresher(storage, cloud, reporter, new InProcessRefreshLock(), undefined, logout, revocations);
  return { storage, cloud, reporter, refresher, logout, log };
};

describe('Desktop legacy Cloud session refresh on the domain ClientSessionService', () => {
  it('risk: token rotation. five concurrent callers cause exactly one refresh and all get the new token', async() => {
    const { storage, cloud, refresher } = rig();
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => refresher.currentAccessToken()));
    expect(cloud.calls).toEqual(['rt-1']);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe(storage.session?.tokens.accessToken);
    expect(storage.session?.tokens.refreshToken).toBe('rt-2');
    expect(storage.writes).toBe(1);
  });

  it('risk: needless network. a token with plenty of life is returned without any call or write', async() => {
    const { storage, cloud, refresher } = rig({ ...expiring(), tokens: { accessToken: jwt(900, 'fresh'), refreshToken: 'rt-1' } });
    expect(await refresher.currentAccessToken()).toBe(storage.session?.tokens.accessToken);
    expect(cloud.calls).toHaveLength(0);
    expect(storage.writes).toBe(0);
  });

  it('risk: sign-in loss. a logout during a refresh never re-writes tokens', async() => {
    const { storage, cloud, refresher } = rig();
    let release!: () => void;
    cloud.gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = refresher.currentAccessToken();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cloud.calls).toHaveLength(1);
    refresher.invalidate(); // sign-out starts
    storage.session = null; // sign-out clears the account
    release();
    expect(await pending).toBe('');
    expect(storage.session).toBeNull();
    expect(storage.writes).toBe(0);
  });

  it('risk: sign-in loss. a logout that has not cleared yet still blocks the in-flight write-back', async() => {
    const { storage, cloud, refresher } = rig();
    let release!: () => void;
    cloud.gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = refresher.currentAccessToken();
    await new Promise(resolve => setTimeout(resolve, 10));
    refresher.invalidate();
    release();
    await pending;
    expect(storage.writes).toBe(0);
    expect(storage.session?.tokens.refreshToken).toBe('rt-1');
  });

  it.each([[429], [500], [503], ['network' as const]])('risk: lost session. failure %s keeps the tokens and returns the stored access token', async(failure) => {
    const { storage, cloud, reporter, refresher } = rig();
    cloud.behaviour = failure;
    const before = storage.session?.tokens.accessToken;
    expect(await refresher.currentAccessToken()).toBe(before);
    expect(storage.session?.tokens).toEqual({ accessToken: before, refreshToken: 'rt-1' });
    expect(storage.writes).toBe(0);
    expect(reporter.failures).toHaveLength(1);
    expect(reporter.failures[0]).not.toContain('rt-1');
  });

  it('risk: lost session. an explicit rejection (401) does not delete anything on Desktop, as before', async() => {
    const { storage, cloud, refresher } = rig();
    cloud.behaviour = 401;
    await refresher.currentAccessToken();
    expect(storage.session?.tokens.refreshToken).toBe('rt-1');
  });

  it('risk: signed out. nobody signed in means an empty token and no call', async() => {
    const { cloud, refresher } = rig(null);
    expect(await refresher.currentAccessToken()).toBe('');
    expect(cloud.calls).toHaveLength(0);
  });
});

describe('Desktop first-run pending Cloud session refresh', () => {
  const entry = () => ({
    values: { access_token: jwt(30, 'old'), refresh_token: 'rt-1', user_id: 'user-1', active_contractor_id: 'user-1', contractors_json: '[]' },
  });
  class Expired extends Error {}
  const pendingRig = () => {
    const cloud = new FakeCloud();
    return { cloud, refresher: new PendingCloudSessionRefresher(cloud, () => new Expired('expired'), new InProcessRefreshLock()) };
  };

  it('risk: token rotation. an expiring pending session is refreshed once, even when two flushes race, and adopted', async() => {
    const { cloud, refresher } = pendingRig();
    const e = entry();
    await Promise.all([refresher.refreshIfExpiring(e), refresher.refreshIfExpiring(e)]);
    expect(cloud.calls).toEqual(['rt-1']);
    expect(e.values.refresh_token).toBe('rt-2');
    expect(e.values.access_token).toContain('.');
    expect(e.values.user_id).toBe('user-1');
  });

  it('risk: needless network. a pending token with more than two minutes left is left alone', async() => {
    const { cloud, refresher } = pendingRig();
    const e = { values: { ...entry().values, access_token: jwt(900, 'fresh') } };
    await refresher.refreshIfExpiring(e);
    expect(cloud.calls).toHaveLength(0);
  });

  it('risk: lost sign-in. 401 means expired (back to sign-in), while 429 and 500 are retryable and keep the tokens', async() => {
    const { cloud, refresher } = pendingRig();
    const e = entry();
    cloud.behaviour = 401;
    await expect(refresher.refreshIfExpiring(e)).rejects.toBeInstanceOf(Expired);
    for (const status of [429, 500, 'network' as const]) {
      cloud.behaviour = status;
      const err = await refresher.refreshIfExpiring(e).catch(x => x);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(Expired);
      expect(String(err.message)).toContain('needs refresh');
    }
    expect(e.values.refresh_token).toBe('rt-1');
  });
});

describe('D-ID-4 server-mode sign-out revokes the Sulla Cloud session (domain SignOutService)', () => {
  const fresh = (refreshToken = 'rt-1'): StoredCloudSession => ({ ...expiring(), tokens: { accessToken: jwt(900, 'fresh'), refreshToken } });

  it('risk: session left alive. logout is POSTed exactly once with the current refresh token, after the local clear', async() => {
    const { storage, refresher, logout, log } = rig(fresh());
    const result = await refresher.signOut();
    expect(logout.calls).toEqual(['rt-1']);
    expect(log).toEqual(['clear', 'logout:rt-1']);
    expect(storage.session).toBeNull();
    expect(result).toEqual({ remoteRevoked: true, queued: false, failedSteps: [] });
  });

  it('risk: session left alive. a refresh in flight finishes first and the NEWEST token is revoked, never written back', async() => {
    const { storage, cloud, refresher, logout, log } = rig();
    let release!: () => void;
    cloud.gate = new Promise<void>((resolve) => { release = resolve; });
    const refreshing = refresher.currentAccessToken();
    await new Promise(resolve => setTimeout(resolve, 10));
    const signingOut = refresher.signOut();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(logout.calls).toHaveLength(0); // waits for the refresh lock
    release();
    await refreshing;
    await signingOut;
    expect(cloud.calls).toEqual(['rt-1']);
    expect(logout.calls).toEqual(['rt-2']);
    expect(log).toEqual(['clear', 'logout:rt-2']);
    expect(storage.session).toBeNull();
  });

  it('risk: inconsistent sign-out. a failed local clear sends no logout, throws, and leaves refresh working', async() => {
    const { storage, cloud, refresher, logout } = rig();
    storage.clearFails = true;
    await expect(refresher.signOut()).rejects.toThrow('vault unavailable');
    expect(logout.calls).toHaveLength(0);
    expect(storage.session?.tokens.refreshToken).toBe('rt-1');
    await refresher.currentAccessToken(); // gate reopened: the still-signed-in session keeps refreshing
    expect(cloud.calls).toEqual(['rt-1']);
  });

  it('risk: false revoke. a blank refresh token is never sent; the local session is still cleared', async() => {
    const { storage, refresher, logout } = rig(fresh(''));
    const result = await refresher.signOut();
    expect(logout.calls).toHaveLength(0);
    expect(storage.session).toBeNull();
    expect(result.remoteRevoked).toBe(false);
  });

  it.each([[401], [403]])('risk: session left alive. logout %s means the server already refuses the token: revoked, nothing queued', async(status) => {
    const revocations = new SpyRevocations();
    const { storage, refresher, logout } = rig(fresh(), revocations);
    logout.behaviour = status;
    expect(await refresher.signOut()).toEqual({ remoteRevoked: true, queued: false, failedSteps: [] });
    expect(revocations.pushed).toHaveLength(0);
    expect(storage.session).toBeNull();
  });

  it.each([[500], [503], ['network' as const]])('risk: offline sign-out. logout failure %s still signs out locally and is not claimed as queued', async(failure) => {
    const { storage, refresher, logout } = rig(fresh());
    logout.behaviour = failure;
    const result = await refresher.signOut();
    expect(logout.calls).toEqual(['rt-1']);
    expect(storage.session).toBeNull();
    // No durable revocation store exists on Desktop, so nothing pretends to be queued.
    expect(result).toEqual({ remoteRevoked: false, queued: false, failedSteps: [] });
  });

  it('risk: transient misread. an empty-body 200 from /auth/logout is a revoke, not a 502, and is never queued', async() => {
    const storage = new MemoryStorage(fresh());
    const revocations = new SpyRevocations();
    const sent: string[] = [];
    const http = new FetchCloudLogoutHttp(async(refreshToken) => { sent.push(refreshToken); return new Response(null, { status: 200 }) });
    const refresher = new LegacyCloudSessionRefresher(storage, new FakeCloud(), new Reporter(), new InProcessRefreshLock(), undefined, http, revocations);
    expect(await refresher.signOut()).toEqual({ remoteRevoked: true, queued: false, failedSteps: [] });
    expect(sent).toEqual(['rt-1']);
    expect(revocations.pushed).toHaveLength(0);
  });

  it('risk: transient misread. the status-only adapter reports 200 for an empty or non-JSON body and the real status otherwise', async() => {
    const respond = (body: string | null, status: number) => new FetchCloudLogoutHttp(async() => new Response(body, { status }));
    expect(await respond(null, 200).post('rt')).toEqual({ status: 200 });
    expect(await respond('not json', 200).post('rt')).toEqual({ status: 200 });
    expect(await respond(null, 204).post('rt')).toEqual({ status: 204 });
    expect(await respond('{"error":"x"}', 401).post('rt')).toEqual({ status: 401 });
  });

  it('risk: dead session after re-sign-in. sign-out closes the refresh gate; a new sign-in reopens it', async() => {
    const { storage, cloud, refresher } = rig(fresh());
    await refresher.signOut();
    storage.session = expiring(); // signed in again, token about to expire
    await refresher.currentAccessToken();
    expect(cloud.calls).toHaveLength(0); // gate still closed: the stale sign-out wins
    refresher.adopted();
    await refresher.currentAccessToken();
    expect(cloud.calls).toEqual(['rt-1']);
    expect(storage.session?.tokens.refreshToken).toBe('rt-2');
  });
});

describe('D-ID-4 sulla-cloud:logout picks the sign-out path by vault mode', () => {
  const ports = (containerVault: boolean, log: string[], clearFails = false) => ({
    usesContainerVault: () => containerVault,
    clearPendingMasterKey: () => { log.push('clearPendingMasterKey') },
    clearPendingCredential: async() => { log.push('clearPendingCredential') },
    clearContainerSession: async() => {
      if (clearFails) throw new Error('vault locked');
      log.push('clearContainerSession');
    },
  });
  const sessions = (log: string[]) => ({
    invalidate: () => { log.push('invalidate') },
    signOut: async() => { log.push('signOut'); return { remoteRevoked: true, queued: false, failedSteps: [] } },
  });

  it('risk: regression. container-vault logout runs exactly the previous steps and never the server revoke', async() => {
    const log: string[] = [];
    expect(await new DesktopCloudSignOut(ports(true, log), sessions(log)).run()).toEqual({ signedOut: true, serverRevoked: null });
    expect(log).toEqual(['invalidate', 'clearPendingMasterKey', 'clearPendingCredential', 'clearContainerSession']);
  });

  it('risk: inconsistent sign-out. a failed container-vault clear reports not signed out', async() => {
    const log: string[] = [];
    const outcome = await new DesktopCloudSignOut(ports(true, log, true), sessions(log)).run();
    expect(outcome.signedOut).toBe(false);
    expect(log).not.toContain('signOut');
  });

  it('risk: session left alive. server mode signs out through the domain SignOutService and reports the revoke', async() => {
    const log: string[] = [];
    expect(await new DesktopCloudSignOut(ports(false, log), sessions(log)).run()).toEqual({ signedOut: true, serverRevoked: true });
    expect(log).toEqual(['clearPendingMasterKey', 'signOut']);
  });

  it('risk: session left alive. server mode end to end: one logout POST after the local clear', async() => {
    const { storage, refresher, logout, log } = rig({ ...expiring(), tokens: { accessToken: jwt(900, 'fresh'), refreshToken: 'rt-9' } });
    const outcome = await new DesktopCloudSignOut(ports(false, []), refresher).run();
    expect(outcome).toEqual({ signedOut: true, serverRevoked: true });
    expect(logout.calls).toEqual(['rt-9']);
    expect(log).toEqual(['clear', 'logout:rt-9']);
    expect(storage.session).toBeNull();
  });

  it('risk: inconsistent sign-out. a failed server-mode local clear reports not signed out and revokes nothing', async() => {
    const { storage, refresher, logout } = rig();
    storage.clearFails = true;
    const outcome = await new DesktopCloudSignOut(ports(false, []), refresher).run();
    expect(outcome.signedOut).toBe(false);
    expect(logout.calls).toHaveLength(0);
  });
});

describe('D-ID-4 /auth/logout transport and the sign-out token store', () => {
  const fresh = (refreshToken = 'rt-1'): StoredCloudSession => ({ ...expiring(), tokens: { accessToken: jwt(900, 'fresh'), refreshToken } });

  it('risk: false revoke. the transport refuses a blank refresh token and never POSTs it', async() => {
    const logout = new FakeLogout([]);
    const transport = new ElectronCloudRefreshTransport(new FakeCloud(), logout);
    await expect(transport.logout({ refreshToken: '' })).rejects.toThrow('without a refresh token');
    expect(logout.calls).toHaveLength(0);
  });

  it('risk: session left alive. the transport resolves on 2xx and rejects with the HTTP status otherwise, or with no status when offline', async() => {
    const logout = new FakeLogout([]);
    const transport = new ElectronCloudRefreshTransport(new FakeCloud(), logout);
    logout.behaviour = 204;
    await expect(transport.logout({ refreshToken: 'rt-1' })).resolves.toBeUndefined();
    logout.behaviour = 401;
    await expect(transport.logout({ refreshToken: 'rt-1' })).rejects.toMatchObject({ status: 401 });
    logout.behaviour = 503;
    await expect(transport.logout({ refreshToken: 'rt-1' })).rejects.toMatchObject({ status: 503 });
    logout.behaviour = 'network';
    const offline = await transport.logout({ refreshToken: 'rt-1' }).catch((error: unknown) => error);
    expect(offline).toBeInstanceOf(Error);
    expect((offline as { status?: number }).status).toBeUndefined();
    expect(logout.calls).toEqual(['rt-1', 'rt-1', 'rt-1', 'rt-1']);
  });

  it('risk: session resurrected. a session read before sign-out can never be written back after the clear', async() => {
    const storage = new MemoryStorage(fresh());
    const legacy = new LegacyTokenStore(storage);
    const before = await legacy.read();
    expect(before).not.toBeNull();
    await new LegacySignOutTokenStore(legacy, storage).clear();
    expect(storage.session).toBeNull();
    storage.session = fresh('rt-other'); // e.g. a new sign-in landed meanwhile
    const rotated = (await legacy.read())!; // a valid shape for the write, carrying new tokens
    expect(await legacy.compareAndSet(before, rotated)).toBe(false);
    expect(storage.writes).toBe(0);
    expect(storage.session?.tokens.refreshToken).toBe('rt-other');
  });

  it('risk: session resurrected. after sign-out a refresh attempt makes no Cloud call and writes nothing', async() => {
    const { storage, cloud, refresher } = rig(fresh());
    await refresher.signOut();
    expect(await refresher.currentAccessToken()).toBe('');
    expect(cloud.calls).toHaveLength(0);
    expect(storage.writes).toBe(0);
    expect(storage.session).toBeNull();
  });
});
