// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 Files keys: HTTP characterization of the Files Cloud escrow and memory-key
// routes. The frozen legacy registerFilesCloudEscrowRoute and the live one are
// mounted on separate ephemeral servers over the same stub service; every
// request must produce the same status, Cache-Control, body and service call.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FilesCloudEscrowError, registerFilesCloudEscrowRoute, type FilesCloudEscrowService } from '../../../../../../services/sulla-vault/src/filesCloudEscrow';
import { registerFilesCloudEscrowRoute as registerLegacyRoute } from '../../Support/E9Legacy/filesCloudEscrow.legacy';
import { E9HttpHarness, type E9HttpRequest } from '../../Support/E9Legacy/E9FilesKeysHttpHarness';

type StubMode = 'ok' | 'escrow-error' | 'bare-error' | 'object-error' | 'status-only';

class StubEscrowService {
  readonly calls: unknown[][] = [];
  mode: StubMode = 'ok';

  private respond(name: string, args: unknown[], value: unknown) {
    this.calls.push([name, ...args]);
    if (this.mode === 'escrow-error') throw new FilesCloudEscrowError('no_cloud_vault', 409, 'No Passwords backup is available in Sulla Cloud.');
    if (this.mode === 'bare-error') throw new Error('kaboom');
    if (this.mode === 'object-error') throw { code: 'weird' };
    if (this.mode === 'status-only') throw Object.assign(new Error('teapot'), { status: 418 });
    return value;
  }

  async wrapMemoryKey(memoryKey: unknown) { return this.respond('wrapMemoryKey', [memoryKey], { wrappedKey: 'd3JhcHBlZA==' }) }
  async unwrapMemoryKey(wrappedKey: unknown) { return this.respond('unwrapMemoryKey', [wrappedKey], { memoryKey: 'bWVtb3J5' }) }
  async key(requestId: unknown, recipientPublicKey: unknown) { return this.respond('key', [requestId, recipientPublicKey], { vaultId: 'v', vaultEpoch: 1, transport: { format: 'sulla-files-sync-transport' } }) }
  async restoreKey(requestId: unknown, recipientPublicKey: unknown) { return this.respond('restoreKey', [requestId, recipientPublicKey], { vaultId: 'v', vaultEpoch: 2, transport: { format: 'sulla-files-sync-transport' } }) }
  async unlockCloud(password: unknown) { return this.respond('unlockCloud', [password], { unlocked: true, expiresAt: 1 }) }
}

type Register = typeof registerFilesCloudEscrowRoute;

class EscrowRouteSide {
  readonly service = new StubEscrowService();
  readonly withHuman: E9HttpHarness;
  readonly withoutHuman: E9HttpHarness;

  constructor(register: Register) {
    const service = this.service as unknown as FilesCloudEscrowService;
    const desktop = (request: { header(name: string): string | undefined }) => {
      if (request.header('x-desktop') !== 'approved') throw Object.assign(new Error('Desktop approval identity is invalid'), { status: 401, code: 'invalid_service_identity' });
    };
    const human = (request: { header(name: string): string | undefined }) => {
      if (request.header('x-human') !== 'session') throw Object.assign(new Error('Human session required'), { status: 403, code: 'human_session_required' });
    };
    this.withHuman = new E9HttpHarness(app => register(app, service, desktop as never, human as never));
    this.withoutHuman = new E9HttpHarness(app => register(app, service, desktop as never));
  }

  async start() { await this.withHuman.start(); await this.withoutHuman.start() }
  async stop() { await this.withHuman.stop(); await this.withoutHuman.stop() }
}

class Fixture {
  readonly legacySide = new EscrowRouteSide(registerLegacyRoute as unknown as Register);
  readonly nextSide = new EscrowRouteSide(registerFilesCloudEscrowRoute);

  async both(request: E9HttpRequest, mode: StubMode = 'ok', human = true) {
    const results = [];
    for (const side of [this.legacySide, this.nextSide]) {
      side.service.mode = mode;
      side.service.calls.length = 0;
      const response = await (human ? side.withHuman : side.withoutHuman).send(request);
      results.push({ response, calls: [...side.service.calls] });
    }
    expect(results[1]).toEqual(results[0]);
    return results[1];
  }
}

const fx = new Fixture();
const ROUTES = [
  { path: '/v1/memory-sync/wrap-key', body: { memoryKey: 'bWVtb3J5' }, call: 'wrapMemoryKey', fallback: 'memory_key_wrap_failed' },
  { path: '/v1/memory-sync/unwrap-key', body: { wrappedKey: 'd3JhcHBlZA==' }, call: 'unwrapMemoryKey', fallback: 'memory_key_unwrap_failed' },
  { path: '/v1/files/cloud-escrow/key', body: { requestId: 'r', recipientPublicKey: 'p' }, call: 'key', fallback: 'files_cloud_escrow_failed' },
  { path: '/v1/files/cloud-escrow/restore-key', body: { requestId: 'r', recipientPublicKey: 'p' }, call: 'restoreKey', fallback: 'files_cloud_restore_failed' },
];
const HUMAN_ROUTE = { path: '/v1/human/files/cloud-escrow/unlock', body: { password: 'correct horse' }, call: 'unlockCloud', fallback: 'files_cloud_restore_failed' };
beforeAll(async() => { await fx.legacySide.start(); await fx.nextSide.start() });
afterAll(async() => { await fx.legacySide.stop(); await fx.nextSide.stop() });

describe.sequential('E9 Files keys: Files escrow routes equivalence (legacy copy vs live)', () => {
  it('requires the desktop approval identity on every desktop route', async() => { // risk: Files or agents fetch escrow keys directly
    for (const route of ROUTES) {
      const denied = await fx.both({ method: 'POST', path: route.path, body: route.body });
      expect(denied.response).toMatchObject({ status: 401, cacheControl: null, body: JSON.stringify({ error: 'invalid_service_identity', message: 'Desktop approval identity is invalid' }) });
      expect(denied.calls).toEqual([]);
    }
  });

  it('serves every route uncached and maps each error shape identically', async() => { // risk: escrow keys cached or error contract drift
    for (const route of [...ROUTES, HUMAN_ROUTE]) {
      for (const mode of ['ok', 'escrow-error', 'bare-error', 'object-error', 'status-only'] as StubMode[]) {
        for (const human of [true, false]) {
          await fx.both({ method: 'POST', path: route.path, headers: { 'x-desktop': 'approved', 'x-human': 'session' }, body: route.body }, mode, human);
          await fx.both({ method: 'POST', path: route.path, headers: { 'x-desktop': 'approved', 'x-human': 'session' } }, mode, human);
          await fx.both({ method: 'POST', path: route.path, headers: { 'x-desktop': 'approved' }, body: route.body }, mode, human);
        }
      }
      const served = await fx.both({ method: 'POST', path: route.path, headers: { 'x-desktop': 'approved', 'x-human': 'session' }, body: route.body });
      expect(served.response).toMatchObject({ status: 200, cacheControl: 'no-store' });
      expect(served.calls).toEqual([[route.call, ...Object.values(route.body)]]);
      const bare = await fx.both({ method: 'POST', path: route.path, headers: { 'x-desktop': 'approved', 'x-human': 'session' }, body: route.body }, 'bare-error');
      expect(bare.response).toMatchObject({ status: 500, body: JSON.stringify({ error: route.fallback, message: 'kaboom' }) });
      const shapeless = await fx.both({ method: 'POST', path: route.path, headers: { 'x-desktop': 'approved', 'x-human': 'session' }, body: route.body }, 'object-error');
      expect(shapeless.response).toMatchObject({ status: 500, body: JSON.stringify({ error: 'weird' }) });
    }
  });

  it('gates the human unlock route on the human session only when wired', async() => { // risk: Cloud password unlock without a human session
    const noSession = await fx.both({ method: 'POST', path: HUMAN_ROUTE.path, body: HUMAN_ROUTE.body });
    expect(noSession.response).toMatchObject({ status: 403, body: JSON.stringify({ error: 'human_session_required', message: 'Human session required' }) });
    expect(noSession.calls).toEqual([]);
    const unwired = await fx.both({ method: 'POST', path: HUMAN_ROUTE.path, body: HUMAN_ROUTE.body }, 'ok', false);
    expect(unwired.response.status).toBe(200);
    expect(unwired.calls).toEqual([['unlockCloud', 'correct horse']]);
  });
});
