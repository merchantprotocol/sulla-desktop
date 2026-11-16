// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 Files keys: HTTP characterization of the /v1/desktop/files key bundle
// router. The frozen legacy router and the live createFilesKeyBundleRouter are
// mounted on separate ephemeral servers over the same stub authority; every
// request must produce the same status, Cache-Control, content type, body and
// authority call.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VaultFilesKeyBundleError } from '../../../../../../services/sulla-vault/src/filesKeyBundleAuthority';
import type { VaultFilesKeyBundleAuthority } from '../../../../../../services/sulla-vault/src/filesKeyBundleAuthority';
import { createFilesKeyBundleRouter } from '../../../../../../services/sulla-vault/src/filesKeyBundleRoutes';
import { createFilesKeyBundleRouter as createLegacyRouter } from '../../Support/E9Legacy/filesKeyBundleRoutes.legacy';
import { E9HttpHarness, type E9HttpRequest } from '../../Support/E9Legacy/E9FilesKeysHttpHarness';
import { E9Outcome } from '../../Support/E9Legacy/E9FilesKeysOutcome';

const SERVICE_ID = 'sulla-files';
const TOKEN = 'files_' + 'e'.repeat(64);

type StubMode = 'ok' | 'vault-error' | 'plain-error' | 'locked';

class StubAuthority {
  readonly calls: unknown[][] = [];
  mode: StubMode = 'ok';

  private respond<T>(name: string, args: unknown[], value: T): T {
    this.calls.push([name, ...args]);
    if (this.mode === 'vault-error') throw new VaultFilesKeyBundleError('bundle_conflict', 409, 'Conflicting immutable Files custody bundle');
    if (this.mode === 'locked') throw new VaultFilesKeyBundleError('principal_denied', 403, 'Files recovery principal is not the unlocked Vault principal');
    if (this.mode === 'plain-error') throw Object.assign(new Error('vault exploded'), { code: 'vault_locked', status: 423 });
    return value;
  }

  async unlockedPrincipal() { return this.respond('unlockedPrincipal', [], { principalId: 'principal-e9', generation: 3 }) }
  async custodyRecipient(context: unknown) { return this.respond('custodyRecipient', [context], { keyId: 'vault-user-x25519:v1:principal-e9:abc', publicKey: 'cHVibGlj' }) }
  async registerBundle(bundle: unknown) { return this.respond('registerBundle', [bundle], undefined) }
  async authorizeDeviceRecovery(request: unknown) { return this.respond('authorizeDeviceRecovery', [request], { version: 1, purpose: 'device-recovery', context: { principalId: 'principal-e9' } }) }
}

class BackupCredentials {
  readonly calls: unknown[][] = [];
  failing = false;
  readonly fn = async(itemId: string, target: string): Promise<Record<string, string>> => {
    this.calls.push([itemId, target]);
    if (this.failing) throw new VaultFilesKeyBundleError('backup_denied', 403, 'Backup credentials denied');
    return { accessKeyId: 'AKIA-e9', target };
  };
}

type RouterFactory = typeof createFilesKeyBundleRouter;

class RouterSide {
  readonly authority = new StubAuthority();
  readonly backup = new BackupCredentials();
  readonly withBackup: E9HttpHarness;
  readonly withoutBackup: E9HttpHarness;

  constructor(factory: RouterFactory) {
    const identity = { serviceId: SERVICE_ID, token: TOKEN };
    const authority = this.authority as unknown as VaultFilesKeyBundleAuthority;
    this.withBackup = new E9HttpHarness(app => { app.use('/v1/desktop/files', factory(authority, identity, this.backup.fn)) });
    this.withoutBackup = new E9HttpHarness(app => { app.use('/v1/desktop/files', factory(authority, identity)) });
  }

  async start() { await this.withBackup.start(); await this.withoutBackup.start() }
  async stop() { await this.withBackup.stop(); await this.withoutBackup.stop() }
}

class Fixture {
  readonly legacySide = new RouterSide(createLegacyRouter as unknown as RouterFactory);
  readonly nextSide = new RouterSide(createFilesKeyBundleRouter);
  readonly auth = { 'x-sulla-service-id': SERVICE_ID, authorization: `Bearer ${ TOKEN }` };

  /** Same request on both servers (with or without backup credentials); identical responses and calls. */
  async both(request: E9HttpRequest, options: { mode?: StubMode; backup?: boolean; backupFailing?: boolean } = {}) {
    const results = [];
    for (const side of [this.legacySide, this.nextSide]) {
      side.authority.mode = options.mode ?? 'ok';
      side.backup.failing = options.backupFailing ?? false;
      side.authority.calls.length = 0;
      side.backup.calls.length = 0;
      const harness = options.backup === false ? side.withoutBackup : side.withBackup;
      const response = await harness.send(request);
      results.push({ response, calls: [...side.authority.calls], backupCalls: [...side.backup.calls] });
    }
    expect(results[1]).toEqual(results[0]);
    return results[1];
  }
}

const fx = new Fixture();
const context = { principalId: 'principal-e9', collectionId: 'col-a', keyVersion: 2, epoch: 3 };
beforeAll(async() => { await fx.legacySide.start(); await fx.nextSide.start() });
afterAll(async() => { await fx.legacySide.stop(); await fx.nextSide.stop() });

describe.sequential('E9 Files keys: key bundle router equivalence (legacy copy vs live)', () => {
  it('refuses a misconfigured service identity at construction with the same error', () => { // risk: router mounted without authentication
    const authority = new StubAuthority() as unknown as VaultFilesKeyBundleAuthority;
    const identities = [
      { serviceId: '', token: TOKEN },
      { serviceId: SERVICE_ID, token: '' },
      { serviceId: SERVICE_ID, token: 'x'.repeat(31) },
      { serviceId: SERVICE_ID, token: 'x'.repeat(32) },
      { serviceId: SERVICE_ID, token: 'é'.repeat(16) },
      { serviceId: SERVICE_ID, token: 'é'.repeat(15) + 'x' },
    ];
    for (const identity of identities) {
      const legacyOutcome = E9Outcome.sync(() => typeof createLegacyRouter(authority, identity));
      const nextOutcome = E9Outcome.sync(() => typeof createFilesKeyBundleRouter(authority, identity));
      expect(nextOutcome).toEqual(legacyOutcome);
    }
    expect(E9Outcome.sync(() => createFilesKeyBundleRouter(authority, { serviceId: '', token: TOKEN })))
      .toMatchObject({ ok: false, type: 'Error', message: 'Vault Files service identity is not configured' });
  });

  it('rejects every request without the exact Files service identity', async() => { // risk: unauthenticated key recovery
    const variants: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${ TOKEN }` },
      { 'x-sulla-service-id': SERVICE_ID },
      { 'x-sulla-service-id': 'sulla-tools', authorization: `Bearer ${ TOKEN }` },
      { 'x-sulla-service-id': SERVICE_ID, authorization: `Bearer ${ TOKEN }x` },
      { 'x-sulla-service-id': SERVICE_ID, authorization: `Bearer ${ TOKEN.slice(0, -1) }f` },
      { 'x-sulla-service-id': SERVICE_ID, authorization: `bearer   ${ TOKEN }` },
      { 'x-sulla-service-id': SERVICE_ID, authorization: `Basic ${ TOKEN }` },
    ];
    for (const headers of variants) {
      for (const request of [
        { method: 'GET', path: '/v1/desktop/files/principal', headers },
        { method: 'POST', path: '/v1/desktop/files/device-recovery', headers, body: { context, devicePublicKey: 'ZGV2aWNl' } },
        { method: 'POST', path: '/v1/desktop/files/unknown', headers, body: {} },
      ] as E9HttpRequest[]) await fx.both(request);
    }
    const denied = await fx.both({ method: 'GET', path: '/v1/desktop/files/principal' });
    expect(denied.response).toMatchObject({ status: 401, body: JSON.stringify({ error: 'invalid_service_identity', message: 'Files service identity is invalid' }) });
    expect(denied.calls).toEqual([]);
    // A bare token (no "Bearer " scheme) is an intentional divergence from legacy: legacy accepted it, live refuses it
    // (VaultE9SecurityHardening.spec.ts).
  });

  it('serves principal, custody recipient, registration and device recovery identically', async() => { // risk: Files key exchange contract drift
    const requests: E9HttpRequest[] = [
      { method: 'GET', path: '/v1/desktop/files/principal', headers: fx.auth },
      { method: 'POST', path: '/v1/desktop/files/custody-recipient', headers: fx.auth, body: { context } },
      { method: 'POST', path: '/v1/desktop/files/custody-recipient', headers: fx.auth, body: { context: { ...context, extra: true } } },
      { method: 'POST', path: '/v1/desktop/files/key-bundles', headers: fx.auth, body: { context, authorityKeyId: 'k'.repeat(1024), envelope: { version: 1, purpose: 'authority-custody' } } },
      { method: 'POST', path: '/v1/desktop/files/device-recovery', headers: fx.auth, body: { context, devicePublicKey: 'd'.repeat(1024) } },
      { method: 'GET', path: '/v1/desktop/files/custody-recipient', headers: fx.auth },
      { method: 'POST', path: '/v1/desktop/files/principal', headers: fx.auth, body: {} },
    ];
    for (const request of requests) {
      for (const mode of ['ok', 'vault-error', 'locked', 'plain-error'] as StubMode[]) await fx.both(request, { mode });
    }
    const registered = await fx.both(requests[3]);
    expect(registered.response.status).toBe(204);
    expect(registered.calls).toEqual([['registerBundle', { context, authorityKeyId: 'k'.repeat(1024), envelope: { version: 1, purpose: 'authority-custody' } }]]);
    const conflict = await fx.both(requests[4], { mode: 'vault-error' });
    expect(conflict.response).toMatchObject({ status: 409, body: JSON.stringify({ error: 'bundle_conflict', message: 'Conflicting immutable Files custody bundle' }) });
    const unhandled = await fx.both(requests[0], { mode: 'plain-error' });
    expect(unhandled.response.status).toBe(599);
  });

  it('validates request bodies with the same codes and messages', async() => { // risk: malformed contexts reach the authority
    const bad: unknown[] = [
      undefined, null, [], 'context', {},
      { context: null }, { context: [] }, { context: 'x' },
      { context: { ...context, principalId: '' } },
      { context: { ...context, principalId: 'p'.repeat(512) } },
      { context: { ...context, principalId: 'p'.repeat(513) } },
      { context: { ...context, collectionId: 7 } },
      { context: { ...context, collectionId: 'c'.repeat(513) } },
      { context: { ...context, keyVersion: 0 } },
      { context: { ...context, keyVersion: '2' } },
      { context: { ...context, keyVersion: 2.5 } },
      { context: { ...context, keyVersion: Number.MAX_SAFE_INTEGER + 1 } },
      { context: { ...context, epoch: -1 } },
      { context: { ...context, epoch: null } },
      { context, devicePublicKey: '' },
      { context, devicePublicKey: 'd'.repeat(1025) },
      { context, devicePublicKey: 12 },
      { context, authorityKeyId: '' },
      { context, authorityKeyId: 'k'.repeat(1025), envelope: {} },
      { context, authorityKeyId: 'k', envelope: [] },
      { context, authorityKeyId: 'k', envelope: null },
      { context, authorityKeyId: 'k', envelope: 'e' },
      { context: { ...context, keyVersion: 0 }, authorityKeyId: 'k'.repeat(2000), envelope: [] },
    ];
    for (const body of bad) {
      for (const path of ['/v1/desktop/files/custody-recipient', '/v1/desktop/files/key-bundles', '/v1/desktop/files/device-recovery']) {
        await fx.both({ method: 'POST', path, headers: fx.auth, ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }) });
      }
    }
    const missing = await fx.both({ method: 'POST', path: '/v1/desktop/files/key-bundles', headers: fx.auth, rawBody: '[]' });
    expect(missing.response).toMatchObject({ status: 400, body: JSON.stringify({ error: 'invalid_request', message: 'bundle is required' }) });
    const invalidContext = await fx.both({ method: 'POST', path: '/v1/desktop/files/custody-recipient', headers: fx.auth, body: { context: { ...context, epoch: 0 } } });
    expect(invalidContext.response).toMatchObject({ status: 400, body: JSON.stringify({ error: 'invalid_context', message: 'Files key bundle context is invalid' }) });
    expect(invalidContext.calls).toEqual([]);
  });

  it('serves backup credentials only when wired, uncached, with bounded inputs', async() => { // risk: backup secrets cached or leaked
    const bodies: unknown[] = [
      { itemId: '40000000-0000-4000-8000-000000000001', target: 's3://bucket/path' },
      { itemId: 'i'.repeat(36), target: 't'.repeat(2048) },
      { itemId: 'i'.repeat(37), target: 't' },
      { itemId: 'i', target: 't'.repeat(2049) },
      { itemId: '', target: 't' },
      { itemId: 'i' },
      {},
    ];
    for (const body of bodies) {
      for (const backup of [true, false]) {
        await fx.both({ method: 'POST', path: '/v1/desktop/files/backup-credentials', headers: fx.auth, body }, { backup });
      }
      await fx.both({ method: 'POST', path: '/v1/desktop/files/backup-credentials', headers: fx.auth, body }, { backupFailing: true });
    }
    const served = await fx.both({ method: 'POST', path: '/v1/desktop/files/backup-credentials', headers: fx.auth, body: bodies[0] });
    expect(served.response).toMatchObject({ status: 200, cacheControl: 'no-store' });
    expect(served.backupCalls).toEqual([['40000000-0000-4000-8000-000000000001', 's3://bucket/path']]);
    const unwired = await fx.both({ method: 'POST', path: '/v1/desktop/files/backup-credentials', headers: fx.auth, body: bodies[0] }, { backup: false });
    expect(unwired.response.status).toBe(404);
  });
});
