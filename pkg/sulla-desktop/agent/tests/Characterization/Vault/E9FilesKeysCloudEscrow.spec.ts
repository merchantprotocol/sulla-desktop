// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 Files keys: characterization of the Files Cloud escrow (key derivation,
// one-way transport wrap, memory-key wrap and FilesCloudEscrowService). The
// frozen legacy copy and the live module run with the same pinned ECDH
// ephemeral key and nonce, so their outputs must be byte-identical. Errors are
// compared by constructor, code, status and message.

import { hkdfSync, webcrypto } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CloudSyncAuthority, UnlockedUserKey } from '../../../../../../services/sulla-vault/src/browserEnvelope/syncRunner';
import type { DomainVaultSyncCodecProvider } from '../../../../../../services/sulla-vault/src/browserEnvelope/DomainVaultSyncCodecProvider';
import type { FilesAuditEmitter } from '../../../../../../services/sulla-vault/src/filesAudit';
import { FilesCloudEscrowService, deriveFilesEscrowKey, transportWrap } from '../../../../../../services/sulla-vault/src/filesCloudEscrow';
import * as legacy from '../../Support/E9Legacy/filesCloudEscrow.legacy';
import { E9Outcome } from '../../Support/E9Legacy/E9FilesKeysOutcome';
import { E9VaultTestDatabase } from '../../Support/E9Legacy/E9FilesKeysDatabase';

const subtle = webcrypto.subtle;
const USER = '10000000-0000-4000-8000-0000000000e9';
const OTHER_USER = '10000000-0000-4000-8000-0000000000aa';
const VAULT = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CLOUD_VAULT = '3f2e1d0c-9b8a-4c7d-b6e5-f4a3b2c1d0e9';
const REQUEST = '5b6c7d8e-9f0a-4b1c-9d2e-3f4a5b6c7d8e';

/** Pins the ECDH ephemeral key pair and the AES-GCM nonce so a transport wrap is deterministic. */
class PinnedRandomness {
  private pair!: CryptoKeyPair;

  async prepare(): Promise<void> {
    this.pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
  }

  pin(nonceByte = 0x2a): void {
    vi.spyOn(subtle, 'generateKey').mockResolvedValue(this.pair as never);
    vi.spyOn(webcrypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => { array.fill(nonceByte); return array }) as never);
  }
}

/** The receiving side of the transport (what sulla-files does), used to prove the wire contract. */
class TransportRecipient {
  pair!: CryptoKeyPair;
  publicKey = '';

  async prepare(): Promise<void> {
    this.pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    this.publicKey = Buffer.from(await subtle.exportKey('raw', this.pair.publicKey)).toString('base64url');
  }

  async open(transport: { epk: string; nonce: string; ct: string }, requestId: string, vaultId: string, vaultEpoch: number): Promise<string> {
    const enc = new TextEncoder();
    const epk = await subtle.importKey('raw', Buffer.from(transport.epk, 'base64url'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, this.pair.privateKey, 256);
    const info = `${ requestId }|${ vaultId }|${ vaultEpoch }`;
    const wrapping = hkdfSync('sha256', new Uint8Array(shared), enc.encode('sulla-files-sync-transport-v1'), enc.encode(info), 32);
    const aes = await subtle.importKey('raw', new Uint8Array(wrapping), { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(transport.nonce, 'base64url'), additionalData: enc.encode(`sulla-fs1|transport|${ info }|${ transport.epk }`), tagLength: 128 },
      aes, Buffer.from(transport.ct, 'base64url'),
    );
    return Buffer.from(plain).toString('hex');
  }
}

class FakeCloudAuthority implements CloudSyncAuthority {
  mode: 'ok' | 'locked' | 'failing' = 'ok';
  userId = USER;
  readonly userKey = new Uint8Array(32).fill(9);
  assertCalls = 0;
  readonly requests: unknown[] = [];
  responses: { status: number; headers: Record<string, string>; body: unknown }[] = [];

  async withUnlockedUserKey<T>(operation: (keys: UnlockedUserKey) => Promise<T>): Promise<T> {
    if (this.mode === 'locked') throw Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
    if (this.mode === 'failing') throw Object.assign(new Error('database unavailable'), { code: 'db_down', status: 503 });
    return operation({ userId: this.userId, userKey: new Uint8Array(this.userKey), assertCurrent: () => { this.assertCalls += 1 } });
  }

  async sullaCloudRequest(input: { method: string; path: string }) {
    this.requests.push(input);
    return this.responses.shift() ?? { status: 500, headers: {}, body: null };
  }
}

class RecordingAudit {
  readonly events: unknown[] = [];
  emit(event: unknown): void { this.events.push(event) }
}

class FakeCodecProvider {
  readonly unlocked: unknown[] = [];
  async get() {
    return {
      unlockBundle: (bundle: unknown, password: string) => {
        this.unlocked.push(bundle);
        if (password !== 'correct horse') throw new Error('bundle authentication failed');
        return new Uint8Array(32).fill(5);
      },
    };
  }
}

interface ServiceLike {
  wrapMemoryKey(memoryKey: string): Promise<unknown>;
  unwrapMemoryKey(wrappedKey: string): Promise<unknown>;
  key(requestId: string, recipientPublicKey: string): Promise<unknown>;
  clearCloudSessionKey(): void;
  unlockCloud(password: string): Promise<unknown>;
  restoreKey(requestId: string, recipientPublicKey: string): Promise<unknown>;
}

class EscrowSide {
  readonly authority = new FakeCloudAuthority();
  readonly audit = new RecordingAudit();
  readonly codec = new FakeCodecProvider();
  service!: ServiceLike;

  constructor(private readonly build: (db: E9VaultTestDatabase['db'], authority: CloudSyncAuthority, audit: FilesAuditEmitter, codec: DomainVaultSyncCodecProvider) => ServiceLike) {}

  init(db: E9VaultTestDatabase['db']): void {
    this.service = this.build(db, this.authority, this.audit as unknown as FilesAuditEmitter, this.codec as unknown as DomainVaultSyncCodecProvider);
  }

  observed() {
    return { requests: [...this.authority.requests], events: [...this.audit.events], unlocked: [...this.codec.unlocked], assertCalls: this.authority.assertCalls };
  }
}

class Fixture {
  readonly database = new E9VaultTestDatabase();
  readonly pinned = new PinnedRandomness();
  readonly recipient = new TransportRecipient();
  readonly legacySide = new EscrowSide((db, authority, audit, codec) => new legacy.FilesCloudEscrowService(db, authority, audit, codec));
  readonly nextSide = new EscrowSide((db, authority, audit, codec) => new FilesCloudEscrowService(db, authority, audit, codec));

  async setup(): Promise<void> {
    await this.database.setup();
    await this.database.seedUser(USER);
    await this.database.seedUser(OTHER_USER);
    await this.pinned.prepare();
    await this.recipient.prepare();
    this.legacySide.init(this.database.db);
    this.nextSide.init(this.database.db);
  }

  async both(step: (side: EscrowSide) => Promise<unknown>, prepare?: (side: EscrowSide) => void): Promise<Record<string, unknown>> {
    prepare?.(this.legacySide);
    const legacyOutcome = await E9Outcome.of(() => step(this.legacySide));
    prepare?.(this.nextSide);
    const nextOutcome = await E9Outcome.of(() => step(this.nextSide));
    expect(nextOutcome).toEqual(legacyOutcome);
    expect(this.nextSide.observed()).toEqual(this.legacySide.observed());
    return nextOutcome;
  }

  async pair<T>(run: (impl: { derive: typeof deriveFilesEscrowKey; wrap: typeof transportWrap }) => Promise<T>) {
    const legacyOutcome = await E9Outcome.of(() => run({ derive: legacy.deriveFilesEscrowKey, wrap: legacy.transportWrap }));
    const nextOutcome = await E9Outcome.of(() => run({ derive: deriveFilesEscrowKey, wrap: transportWrap }));
    expect(nextOutcome).toEqual(legacyOutcome);
    return nextOutcome;
  }
}

const fx = new Fixture();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
beforeAll(async() => { await fx.setup() }, 60_000);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() });
afterAll(async() => { await fx.database.close() });

describe.sequential('E9 Files keys: Files escrow crypto equivalence (legacy copy vs live)', () => {
  it('derives the same domain-separated escrow key, matching HKDF-SHA256', async() => { // risk: escrow key drift makes every Cloud backup unreadable
    const cases: [Uint8Array, string, number][] = [
      [new Uint8Array(32).fill(9), VAULT, 1],
      [new Uint8Array(32).fill(9), VAULT, 2],
      [new Uint8Array(32).fill(9), CLOUD_VAULT, 1],
      [Uint8Array.from({ length: 32 }, (_, index) => index), VAULT.toUpperCase(), Number.MAX_SAFE_INTEGER],
    ];
    for (const [key, vaultId, epoch] of cases) {
      const outcome = await fx.pair(async impl => hex(await impl.derive(key, vaultId, epoch)));
      const expected = hex(new Uint8Array(hkdfSync('sha256', key, new TextEncoder().encode('sulla-files-sync-escrow-v1'), new TextEncoder().encode(`${ vaultId }|${ epoch }`), 32)));
      expect(outcome).toEqual({ ok: true, value: expected });
    }
    const invalid: [Uint8Array, unknown, unknown][] = [
      [new Uint8Array(31), VAULT, 1], [new Uint8Array(33), VAULT, 1], [new Uint8Array(32), 'not-a-uuid', 1],
      [new Uint8Array(32), '7a1b2c3d-4e5f-6a6b-8c7d-9e0f1a2b3c4d', 1], [new Uint8Array(32), VAULT, 0], [new Uint8Array(32), VAULT, 1.5],
      [new Uint8Array(32), VAULT, '1'], [new Uint8Array(32), VAULT, Number.MAX_SAFE_INTEGER + 1],
    ];
    for (const [key, vaultId, epoch] of invalid) {
      const outcome = await fx.pair(async impl => hex(await impl.derive(key, vaultId as string, epoch as number)));
      expect(outcome).toMatchObject({ ok: false, code: 'invalid_state', status: 409, message: 'invalid_state' });
    }
  });

  it('wraps the escrow key for transport byte-identically under pinned randomness', async() => { // risk: transport format or AAD drift breaks Files restore
    const key = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    for (const [vaultId, epoch, nonceByte] of [[VAULT, 3, 0x2a], [CLOUD_VAULT, 1, 0x01], [VAULT, 99, 0xff]] as [string, number, number][]) {
      fx.pinned.pin(nonceByte);
      const outcome = await fx.pair(impl => impl.wrap(key, fx.recipient.publicKey, REQUEST, vaultId, epoch));
      vi.restoreAllMocks();
      expect(outcome).toMatchObject({ ok: true, value: { format: 'sulla-files-sync-transport', v: 1, alg: 'ECDH-P256+HKDF-SHA256+A256GCM', nonce: Buffer.alloc(12, nonceByte).toString('base64url') } });
      const transport = outcome.value as { epk: string; nonce: string; ct: string };
      expect(Object.keys(transport)).toEqual(['format', 'v', 'alg', 'epk', 'nonce', 'ct']);
      expect(await fx.recipient.open(transport, REQUEST, vaultId, epoch)).toBe(hex(key));
    }
  });

  it('rejects invalid transport inputs with the same errors', async() => { // risk: weak recipient keys accepted
    const key = new Uint8Array(32).fill(1);
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    const cases: [Uint8Array, string, string][] = [
      [new Uint8Array(31), fx.recipient.publicKey, REQUEST],
      [key, fx.recipient.publicKey, 'not-a-uuid'],
      [key, Buffer.alloc(64, 4).toString('base64url'), REQUEST],
      [key, Buffer.alloc(66, 4).toString('base64url'), REQUEST],
      [key, '', REQUEST],
      [key, offCurve, REQUEST],
    ];
    for (const [key32, recipient, requestId] of cases) {
      const outcome = await fx.pair(impl => impl.wrap(key32, recipient, requestId, VAULT, 1));
      expect(outcome).toMatchObject({ ok: false, code: 'invalid_request', status: 400 });
    }
  });
});

describe.sequential('E9 Files keys: FilesCloudEscrowService equivalence (legacy copy vs live, shared PGlite)', () => {
  it('validates requests and reports a missing Cloud vault identically', async() => { // risk: escrow served without a Cloud vault
    for (const [requestId, recipient] of [['nope', fx.recipient.publicKey], [REQUEST, 'r'.repeat(257)], [REQUEST, 7]] as [string, string][]) {
      expect(await fx.both(side => side.service.key(requestId, recipient))).toMatchObject({ ok: false, code: 'invalid_request', status: 400 });
      expect(await fx.both(side => side.service.restoreKey(requestId, recipient))).toMatchObject({ ok: false, code: 'invalid_request', status: 400 });
    }
    expect(await fx.both(side => side.service.key(REQUEST, fx.recipient.publicKey)))
      .toMatchObject({ ok: false, code: 'no_cloud_vault', status: 409, message: 'This desktop does not hold the Cloud vault.' });
    expect(await fx.both(side => side.service.restoreKey(REQUEST, fx.recipient.publicKey)))
      .toMatchObject({ ok: false, code: 'no_cloud_vault', status: 409, message: 'No Passwords backup is available in Sulla Cloud.' });
    await fx.database.db.query('INSERT INTO cloud_vault_sync_state(owner_user_id,vault_id,epoch) VALUES ($1,$2,$3)', [OTHER_USER, CLOUD_VAULT, 1]);
    expect(await fx.both(side => side.service.key(REQUEST, fx.recipient.publicKey)))
      .toMatchObject({ ok: false, code: 'no_cloud_vault', message: 'Turn on Passwords sync first; it holds the Files backup keys.' });
    expect(await fx.both(side => side.service.restoreKey(REQUEST, fx.recipient.publicKey)))
      .toMatchObject({ ok: false, code: 'no_cloud_vault', message: 'Turn on Passwords sync first; it holds the Files backup keys.' });
  });

  it('wraps the escrow key for this user vault and audits it identically', async() => { // risk: wrong vault key escrowed, missing audit
    await fx.database.db.query('INSERT INTO cloud_vault_sync_state(owner_user_id,vault_id,epoch) VALUES ($1,$2,$3)', [USER, VAULT, 3]);
    const outcome = await fx.both(side => side.service.key(REQUEST, fx.recipient.publicKey), () => fx.pinned.pin(0x10));
    expect(outcome).toMatchObject({ ok: true, value: { vaultId: VAULT, vaultEpoch: 3 } });
    const escrow = new Uint8Array(hkdfSync('sha256', new Uint8Array(32).fill(9), new TextEncoder().encode('sulla-files-sync-escrow-v1'), new TextEncoder().encode(`${ VAULT }|3`), 32));
    expect(await fx.recipient.open((outcome.value as { transport: { epk: string; nonce: string; ct: string } }).transport, REQUEST, VAULT, 3)).toBe(hex(escrow));
    vi.restoreAllMocks();
    expect(fx.nextSide.audit.events.at(-1)).toEqual({ subjectKind: 'vault-secret', subjectId: VAULT, action: 'files_cloud_escrow_key_wrapped', actor: 'sulla-vault', result: 'allowed', requestId: REQUEST, meta: { vaultEpoch: '3' } });
    for (const mode of ['locked', 'failing'] as const) {
      const failed = await fx.both(side => side.service.key(REQUEST, fx.recipient.publicKey), side => { side.authority.mode = mode });
      expect(failed).toMatchObject({ ok: false });
      fx.legacySide.authority.mode = 'ok';
      fx.nextSide.authority.mode = 'ok';
    }
    expect(await fx.both(side => side.service.key(REQUEST, 'AAAA'))).toMatchObject({ ok: false, code: 'invalid_request', message: 'recipientPublicKey is invalid' });
  });

  it('wraps and unwraps memory sync keys identically', async() => { // risk: memory backups unreadable across the refactor
    const memoryKey = Buffer.alloc(32, 0x33).toString('base64');
    const wrapped = await fx.both(side => side.service.wrapMemoryKey(memoryKey), () => fx.pinned.pin(0x44));
    vi.restoreAllMocks();
    expect(wrapped).toMatchObject({ ok: true, value: { wrappedKey: expect.any(String) } });
    const wrappedKey = (wrapped.value as { wrappedKey: string }).wrappedKey;
    expect(await fx.both(side => side.service.unwrapMemoryKey(wrappedKey))).toEqual({ ok: true, value: { memoryKey } });
    const tampered = Buffer.from(wrappedKey, 'base64'); tampered[20] ^= 1;
    for (const input of [tampered.toString('base64'), 'short', 'x'.repeat(4097)]) {
      expect(await fx.both(side => side.service.unwrapMemoryKey(input))).toMatchObject({ ok: false });
    }
    for (const input of [Buffer.alloc(31).toString('base64'), '', 'not base64']) {
      expect(await fx.both(side => side.service.wrapMemoryKey(input))).toMatchObject({ ok: false, code: 'invalid_request', status: 400 });
    }
    for (const mode of ['locked', 'failing'] as const) {
      const set = (side: EscrowSide) => { side.authority.mode = mode };
      expect(await fx.both(side => side.service.wrapMemoryKey(memoryKey), set)).toMatchObject({ ok: false });
      expect(await fx.both(side => side.service.unwrapMemoryKey(wrappedKey), set)).toMatchObject({ ok: false });
    }
    expect(await fx.both(side => side.service.wrapMemoryKey(memoryKey), side => { side.authority.mode = 'locked' }))
      .toMatchObject({ ok: false, code: 'vault_locked', status: 423, message: 'vault_locked' });
    fx.legacySide.authority.mode = 'ok';
    fx.nextSide.authority.mode = 'ok';
  });

  it('unlocks the Cloud vault and serves one cached restore key before falling back', async() => { // risk: restore key reused or served after expiry
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
    const queue = (...responses: { status: number; body: unknown }[]) => (side: EscrowSide) => {
      side.authority.responses = responses.map(response => ({ headers: {}, ...response }));
    };
    const status = { status: 200, body: { vaultId: CLOUD_VAULT } };
    const bundle = { status: 200, body: JSON.stringify({ bundle: { vaultId: CLOUD_VAULT, epoch: 4 } }) };
    for (const password of ['', 'p'.repeat(4097), 12]) {
      expect(await fx.both(side => side.service.unlockCloud(password as string))).toMatchObject({ ok: false, code: 'invalid_request', status: 400 });
    }
    expect(await fx.both(side => side.service.unlockCloud('correct horse'), queue({ status: 404, body: {} }))).toMatchObject({ ok: false, code: 'no_cloud_vault' });
    expect(await fx.both(side => side.service.unlockCloud('correct horse'), queue({ status: 200, body: JSON.stringify({ vaultId: 'nope' }) }))).toMatchObject({ ok: false, code: 'no_cloud_vault' });
    expect(await fx.both(side => side.service.unlockCloud('correct horse'), queue(status, { status: 404, body: null }))).toMatchObject({ ok: false, code: 'cloud_bundle_unavailable', status: 404 });
    expect(await fx.both(side => side.service.unlockCloud('correct horse'), queue(status, { status: 0, body: null }))).toMatchObject({ ok: false, code: 'cloud_bundle_unavailable', status: 502 });
    expect(await fx.both(side => side.service.unlockCloud('wrong'), queue(status, bundle))).toMatchObject({ ok: false, code: 'wrong_password', status: 401 });
    expect(await fx.both(side => side.service.unlockCloud('correct horse'), queue(status, bundle)))
      .toEqual({ ok: true, value: { unlocked: true, expiresAt: Date.parse('2026-11-16T12:05:00.000Z') } });

    const cached = await fx.both(side => side.service.restoreKey(REQUEST, fx.recipient.publicKey), () => fx.pinned.pin(0x55));
    vi.restoreAllMocks();
    expect(cached).toMatchObject({ ok: true, value: { vaultId: CLOUD_VAULT, vaultEpoch: 4 } });
    const cloudEscrow = new Uint8Array(hkdfSync('sha256', new Uint8Array(32).fill(5), new TextEncoder().encode('sulla-files-sync-escrow-v1'), new TextEncoder().encode(`${ CLOUD_VAULT }|4`), 32));
    expect(await fx.recipient.open((cached.value as { transport: { epk: string; nonce: string; ct: string } }).transport, REQUEST, CLOUD_VAULT, 4)).toBe(hex(cloudEscrow));
    expect(await fx.both(side => side.service.restoreKey(REQUEST, fx.recipient.publicKey), () => fx.pinned.pin(0x56))).toMatchObject({ ok: true, value: { vaultId: VAULT, vaultEpoch: 3 } });
    vi.restoreAllMocks();

    await fx.both(side => side.service.unlockCloud('correct horse'), queue(status, { status: 200, body: { vaultId: CLOUD_VAULT, epoch: 6 } }));
    vi.setSystemTime(new Date('2026-11-16T12:10:00.000Z'));
    expect(await fx.both(side => side.service.restoreKey(REQUEST, fx.recipient.publicKey), () => fx.pinned.pin(0x57))).toMatchObject({ ok: true, value: { vaultId: VAULT, vaultEpoch: 3 } });
    vi.restoreAllMocks();

    await fx.both(side => side.service.unlockCloud('correct horse'), queue(status, bundle));
    await fx.both(async side => side.service.clearCloudSessionKey());
    expect(await fx.both(side => side.service.restoreKey(REQUEST, fx.recipient.publicKey), side => { side.authority.mode = 'locked' }))
      .toMatchObject({ ok: false, code: 'vault_locked', status: 423, message: 'The signed-in encryption session could not be restored.' });
    fx.legacySide.authority.mode = 'ok';
    fx.nextSide.authority.mode = 'ok';
    expect(fx.nextSide.audit.events.map(event => (event as { action: string }).action)).toEqual(fx.legacySide.audit.events.map(event => (event as { action: string }).action));
  });
});
