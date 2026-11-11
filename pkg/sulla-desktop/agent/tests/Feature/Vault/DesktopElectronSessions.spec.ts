// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { InProcessRefreshLock } from '@sulla/domain';
import { describe, expect, it } from 'vitest';

import { LegacyCloudSessionRefresher, PendingCloudSessionRefresher } from '@pkg/main/cloud/session/DesktopCloudSessionRefreshers';
import type { CloudSessionStorage, StoredCloudSession } from '@pkg/main/cloud/session/DesktopTokenStores';
import type { CloudRefreshHttp } from '@pkg/main/cloud/session/ElectronCloudRefreshTransport';

const jwt = (secondsLeft: number, tag: string) => {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${ part({ alg: 'HS256' }) }.${ part({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + secondsLeft, tag }) }.sig`;
};

class MemoryStorage implements CloudSessionStorage<StoredCloudSession> {
  session: StoredCloudSession | null;
  writes = 0;
  constructor(session: StoredCloudSession | null) { this.session = session; }
  async load() { return this.session ? { ...this.session, tokens: { ...this.session.tokens } } : null; }
  async save(session: StoredCloudSession) { this.writes += 1; this.session = session; }
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

const rig = (session: StoredCloudSession | null = expiring()) => {
  const storage = new MemoryStorage(session);
  const cloud = new FakeCloud();
  const reporter = new Reporter();
  const refresher = new LegacyCloudSessionRefresher(storage, cloud, reporter, new InProcessRefreshLock());
  return { storage, cloud, reporter, refresher };
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
