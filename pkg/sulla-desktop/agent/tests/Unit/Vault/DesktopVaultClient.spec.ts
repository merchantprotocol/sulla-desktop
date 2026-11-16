// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {},
  safeStorage: { isEncryptionAvailable: () => true, decryptString: () => '' },
  session: { fromPartition: () => ({}) },
}));

import { DesktopVaultClient, LocalVaultError, VaultControlIdentityRepository, VaultControlSessionProvider } from '../../../services/DesktopVaultClient';

const IDENTITY = { serviceId: 'sulla-desktop-control', token: 'x'.repeat(40) };
const API = 'https://127.0.0.1:30135';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientWith(fetch: (url: string, init: RequestInit) => Promise<Response>): { client: DesktopVaultClient; fetch: typeof fetch } {
  const sessions = new VaultControlSessionProvider(() => ({ fetch }) as unknown as Electron.Session, { configureSession: async() => undefined } as never);
  const client = new DesktopVaultClient(API, async() => IDENTITY, sessions);

  return { client, fetch };
}

describe('DesktopVaultClient', () => {
  it('sends the control identity and never follows redirects', async() => {
    // risk: authorization — every control call carries the provisioned identity and cannot be redirected elsewhere.
    const seen: { url: string; init: RequestInit }[] = [];
    const { client } = clientWith(async(url, init) => {
      seen.push({ url, init });
      return jsonResponse(200, { state: 'locked', unlocked: false, cacheUpdateRequired: false, migration: { required: false } });
    });

    await client.status();
    const headers = new Headers(seen[0].init.headers);
    expect(seen[0].url).toBe(`${ API }/v1/desktop/status`);
    expect(headers.get('x-sulla-service-id')).toBe('sulla-desktop-control');
    expect(headers.get('authorization')).toBe(`Bearer ${ IDENTITY.token }`);
    expect(seen[0].init.redirect).toBe('error');
  });

  it('caches the last status and reports unlocked from it', async() => {
    // risk: data accuracy — callers read the cached unlock state without a second round trip.
    const { client } = clientWith(async() => jsonResponse(200, { state: 'unlocked', unlocked: true, cacheUpdateRequired: false, migration: { required: false } }));

    await client.status();
    expect(client.isUnlocked()).toBe(true);
    expect(client.cachedStatus().state).toBe('unlocked');
  });

  it('marks the client locked even when the lock call fails', async() => {
    // risk: authorization — a failed lock acknowledgement must never leave the desktop thinking the vault is open.
    const { client } = clientWith(async() => { throw new Error('socket hang up') });
    client.acceptBootstrapResult('unlocked');

    await expect(client.lock()).rejects.toBeInstanceOf(LocalVaultError);
    expect(client.isUnlocked()).toBe(false);
  });

  it('rejects a human session URL that leaves the vault origin', async() => {
    // risk: authorization — a hostile or broken response must not send the human to another origin.
    const { client } = clientWith(async() => jsonResponse(200, { url: 'https://evil.example/vault/x', expiresAt: 1, phase: 'pre-unlock' }));

    await expect(client.createHumanSession()).rejects.toMatchObject({ code: 'invalid_human_session', status: 502 });
  });

  it('keeps a same-origin vault session URL and drops the CSRF value', async() => {
    // risk: secret disclosure — the human session returns only the URL, phase and expiry.
    const { client } = clientWith(async() => jsonResponse(200, { url: '/vault/session/abc', expiresAt: 5, phase: 'pre-unlock', csrf: 'secret' }));

    const session = await client.createHumanSession();
    expect(session).toEqual({ url: `${ API }/vault/session/abc`, expiresAt: 5, phase: 'pre-unlock' });
  });

  it('refuses raw secret egress with a fail-closed error', async() => {
    // risk: secret disclosure — legacy secret methods must never return plaintext.
    const { client } = clientWith(async() => jsonResponse(200, {}));

    await expect(client.list()).rejects.toMatchObject({ code: 'unsupported_secret_egress', status: 403 });
    await expect(client.resolveCredential('id')).rejects.toMatchObject({ code: 'unsupported_secret_egress' });
  });
});

describe('VaultControlIdentityRepository', () => {
  it('refuses a too-short control token and never returns it', async() => {
    // risk: authorization — a weak or unprovisioned control capability must fail closed.
    const repository = new VaultControlIdentityRepository(
      () => ({ isEncryptionAvailable: () => true, decryptString: () => 'short' }) as never,
      () => '/app-home',
      async() => Buffer.from('encrypted'),
    );

    await expect(repository.load()).rejects.toMatchObject({ code: 'vault_unavailable', status: 503 });
  });
});
