// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { InProcessRefreshLock } from '@sulla/domain';
import { describe, expect, it } from 'vitest';

import { ElectronCloudAccountTransport } from '@pkg/main/cloud/account/ElectronCloudAccountTransport';
import { SullaCloudHttpClient } from '@pkg/main/cloud/account/SullaCloudHttpClient';
import { LegacyCloudSessionRefresher } from '@pkg/main/cloud/session/DesktopCloudSessionRefreshers';
import { DesktopCloudSignOut, type DesktopSignOutPorts } from '@pkg/main/cloud/session/DesktopCloudSignOut';
import type { CloudSessionStorage, StoredCloudSession } from '@pkg/main/cloud/session/DesktopTokenStores';

/**
 * D-ID-4b: `sulla-cloud:logout` wired exactly as sullaCloudAuth.ts wires it (DesktopCloudSignOut -> the server-mode
 * LegacyCloudSessionRefresher -> domain SignOutService -> ElectronCloudAccountTransport.logout), with nothing swapped
 * but the network: the transport's own /auth/logout request goes over a real SullaCloudHttpClient to a fake fetch.
 */

const jwt = (secondsLeft: number, tag: string) => {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${ part({ alg: 'HS256' }) }.${ part({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + secondsLeft, tag }) }.sig`;
};

interface SeenRequest { method: string; url: string; contentType: string | null; body: Record<string, unknown> }

/** Sulla Cloud's /auth/refresh and /auth/logout as seen on the wire. Logs each request next to the local clear. */
class FakeSullaCloudWire {
  readonly requests: SeenRequest[] = [];
  logout: number | 'network' = 200;
  refreshGate: Promise<void> | null = null;
  private rotations = 0;

  constructor(private readonly log: string[]) {}

  readonly fetch = async(url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    const path = new URL(url).pathname;
    this.requests.push({ method: String(init.method), url, contentType: new Headers(init.headers).get('content-type'), body });
    this.log.push(`${ path }:${ String(body.refreshToken) }`);
    if (path === '/auth/logout') {
      if (this.logout === 'network') throw new TypeError('fetch failed');
      return new Response(this.logout === 204 ? null : '', { status: this.logout });
    }
    if (path === '/auth/refresh') {
      if (this.refreshGate) await this.refreshGate;
      this.rotations += 1;
      return Response.json({ accessToken: jwt(900, `new${ this.rotations }`), refreshToken: `rt-${ this.rotations + 1 }` });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  };

  paths(): string[] {
    return this.requests.map(r => `${ r.method } ${ new URL(r.url).pathname }`);
  }
}

class MemoryStorage implements CloudSessionStorage<StoredCloudSession> {
  session: StoredCloudSession | null;
  writes = 0;
  constructor(session: StoredCloudSession | null, private readonly log: string[]) { this.session = session; }
  async load() { return this.session ? { ...this.session, tokens: { ...this.session.tokens } } : null; }
  async save(session: StoredCloudSession) { this.log.push('save'); this.writes += 1; this.session = session; }
  async clear() { this.log.push('clear'); this.session = null; }
}

const session = (accessToken: string, refreshToken: string): StoredCloudSession => ({
  userId: 'user-1', activeContractorId: 'user-1', contractors: [], tokens: { accessToken, refreshToken },
});

const ports = (containerVault: boolean, log: string[]): DesktopSignOutPorts => ({
  usesContainerVault:     () => containerVault,
  clearPendingMasterKey:  () => { log.push('clearPendingMasterKey') },
  clearPendingCredential: async() => { log.push('clearPendingCredential') },
  clearContainerSession:  async() => { log.push('clearContainerSession') },
});

/** The production wiring: one ElectronCloudAccountTransport (no test seams) shared by refresh and sign-out. */
const desktop = (stored: StoredCloudSession | null, containerVault = false) => {
  const log: string[] = [];
  const cloud = new FakeSullaCloudWire(log);
  const transport = new ElectronCloudAccountTransport({ http: new SullaCloudHttpClient(cloud.fetch, 'https://cloud.test', 20_000, 0) });
  const storage = new MemoryStorage(stored, log);
  const sessions = new LegacyCloudSessionRefresher(storage, transport, { failed() {}, refreshed() {} }, new InProcessRefreshLock());
  return { log, cloud, storage, sessions, signOut: new DesktopCloudSignOut(ports(containerVault, log), sessions) };
};

describe('D-ID-4b server-mode sign-out revokes through ElectronCloudAccountTransport', () => {
  it('risk: session left alive. one POST /auth/logout with the refresh token, after the local clear', async() => {
    const { log, cloud, storage, signOut } = desktop(session(jwt(900, 'fresh'), 'rt-9'));

    expect(await signOut.run()).toEqual({ signedOut: true, serverRevoked: true });

    expect(cloud.requests).toEqual([{
      method: 'POST', url: 'https://cloud.test/auth/logout', contentType: 'application/json', body: { refreshToken: 'rt-9' },
    }]);
    expect(log).toEqual(['clearPendingMasterKey', 'clear', '/auth/logout:rt-9']);
    expect(storage.session).toBeNull();
  });

  it('risk: transient misread. an empty-body 204 from /auth/logout is a revoke', async() => {
    const { cloud, signOut } = desktop(session(jwt(900, 'fresh'), 'rt-9'));
    cloud.logout = 204;

    expect(await signOut.run()).toEqual({ signedOut: true, serverRevoked: true });
  });

  it.each([[500], [503], ['network' as const]])(
    'risk: false revoke. logout %s is not reported as revoked, is sent once, and the local sign-out still holds',
    async(failure) => {
      const { cloud, storage, sessions, signOut } = desktop(session(jwt(900, 'fresh'), 'rt-9'));
      cloud.logout = failure;

      expect(await signOut.run()).toEqual({ signedOut: true, serverRevoked: false });

      expect(cloud.paths()).toEqual(['POST /auth/logout']);
      expect(storage.session).toBeNull();
      // Signed out: no token, no Cloud call, nothing written back.
      expect(await sessions.currentAccessToken()).toBe('');
      expect(cloud.paths()).toEqual(['POST /auth/logout']);
      expect(storage.writes).toBe(0);
    },
  );

  it('risk: session resurrected. a refresh in flight finishes first; the NEWEST token is revoked and never written back', async() => {
    const { log, cloud, storage, sessions, signOut } = desktop(session(jwt(10, 'old'), 'rt-1'));
    let release!: () => void;
    cloud.refreshGate = new Promise<void>((resolve) => { release = resolve });

    const refreshing = sessions.currentAccessToken();
    await new Promise(resolve => setTimeout(resolve, 0));
    const signingOut = signOut.run();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cloud.paths()).toEqual(['POST /auth/refresh']); // logout waits for the refresh lock
    release();
    await refreshing;

    expect(await signingOut).toEqual({ signedOut: true, serverRevoked: true });
    // The rotated pair is saved before the clear; nothing is written after it, and the rotated token is the one revoked.
    expect(log).toEqual(['/auth/refresh:rt-1', 'clearPendingMasterKey', 'save', 'clear', '/auth/logout:rt-2']);
    expect(storage.session).toBeNull();
    expect(await sessions.currentAccessToken()).toBe('');
    expect(storage.session).toBeNull();
  });

  it('risk: regression. container-vault sign-out sends no /auth/ request at all (the vault service owns that session)', async() => {
    const { log, cloud, storage, signOut } = desktop(session(jwt(900, 'fresh'), 'rt-9'), true);

    expect(await signOut.run()).toEqual({ signedOut: true, serverRevoked: null });

    expect(cloud.requests).toEqual([]);
    expect(log).toEqual(['clearPendingMasterKey', 'clearPendingCredential', 'clearContainerSession']);
    expect(storage.session).not.toBeNull();
  });
});
