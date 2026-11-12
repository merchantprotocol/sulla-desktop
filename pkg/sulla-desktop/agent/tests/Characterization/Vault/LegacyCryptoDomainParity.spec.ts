// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// M3 S7a: opens the SAME frozen legacy goldens (services/sulla-vault/test/fixtures/legacy-crypto/) with the
// @sulla/domain classes S7 will move the local vault onto. For each persisted format it checks two things:
// the domain class reads today's bytes, and, when given the same random draws, it writes them byte-for-byte.
// A failure here is an S7 gap.
//
// This PR doesn't vendor a candidate build. The spec is skipped unless SULLA_DOMAIN_CANDIDATE_DIST points at
// an extracted candidate's dist/index.js (e.g. sulla-domain-0.3.2-rc.1.tgz -> package/dist/index.js, with
// its dependencies resolvable from that package).

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { decryptWithKey, deriveLoginHash, deriveMasterKey, unwrapUserKey, unwrapUserPrivateKey, type EncryptedEnvelope } from '@sulla/vault-crypto';
import { LegacyCryptoFixtureStore, type LegacyCryptoFixture } from '../../Support/LegacyCryptoFixture';

const CANDIDATE = process.env.SULLA_DOMAIN_CANDIDATE_DIST ?? '';

type Envelope = { version: 1; algorithm: 'xchacha20-poly1305'; nonce: string; ciphertext: string };
type Kdf = { alg: 'argon2id13'; salt: string; memoryBytes: number; ops: number };
type Params = { memoryBytes: number; operations: number };
interface UserRow { id: string; login_hash_salt: { $bytea: string }; login_hash_verifier: { $bytea: string }; public_key: string; encrypted_private_key: Envelope; encrypted_user_key: Envelope; kdf: Record<string, unknown> }
interface ItemRow { id: string; owner_user_id: string; ciphertext: Envelope; encrypted_item_key: Envelope }
interface RecoveryRow { recovery_salt: string; recovery_verifier: string; encrypted_user_key: Envelope }

/* eslint-disable @typescript-eslint/no-explicit-any -- the candidate is loaded dynamically from outside the repo */
type Domain = Record<string, any>;

/** Replays recorded random draws in order, so a domain writer can be compared with today's bytes. */
class ScriptedRandom {
  private readonly queue: Uint8Array[];
  readonly lengths: number[] = [];

  constructor(...draws: Uint8Array[]) { this.queue = draws }

  bytes(length: number): Uint8Array {
    this.lengths.push(length);
    const next = this.queue.shift();
    if (!next || next.byteLength !== length) throw new Error(`unexpected random draw of ${ length } bytes`);
    return Uint8Array.from(next);
  }
}

/** Builds the domain objects the way S7 is expected to wire them. */
class DomainKit {
  readonly crypto: any;
  readonly wraps: any;

  constructor(readonly domain: Domain) {
    this.crypto = new domain.NobleCryptoPrimitives();
    this.wraps = new domain.KeyWrap(this.crypto, domain.WebCryptoRandomSource.fromGlobal());
  }

  credential(random: { bytes(length: number): Uint8Array } = this.domain.WebCryptoRandomSource.fromGlobal()): any {
    return new this.domain.DesktopLocalCredential(this.crypto, this.wraps, new this.domain.NobleScryptFunction(), random);
  }

  kdf(stored: unknown): Kdf { return this.domain.DesktopLocalKdfRecord.parse(stored).passwordKdf() }
}

class Golden {
  static bytes(value: { $bytea: string }): Uint8Array { return Uint8Array.from(Buffer.from(value.$bytea, 'base64')) }
  static b64u(value: string): Uint8Array { return Uint8Array.from(Buffer.from(value, 'base64url')) }
  static sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
  static user(fixture: LegacyCryptoFixture, state: keyof LegacyCryptoFixture['states'] = 'initial'): UserRow { return fixture.states[state].users[0] as unknown as UserRow }
  static items(fixture: LegacyCryptoFixture): ItemRow[] { return fixture.states.initial.items as unknown as ItemRow[] }
  static recovery(fixture: LegacyCryptoFixture): RecoveryRow { return fixture.states.initial.recovery[0] as unknown as RecoveryRow }

  /** Today's user key, via today's code (the reference the domain must agree with). */
  static async userKey(fixture: LegacyCryptoFixture): Promise<Uint8Array> {
    const user = Golden.user(fixture);
    const password = user.kdf.password as { salt: string; parameters: Params };
    const master = await deriveMasterKey(fixture.secrets.password, password.salt, password.parameters);
    return unwrapUserKey(user.encrypted_user_key as EncryptedEnvelope, master.key);
  }
}

let fixture: LegacyCryptoFixture;
let kit: DomainKit;

describe.skipIf(!CANDIDATE)(`legacy local vault goldens through the @sulla/domain candidate (${ CANDIDATE || 'SULLA_DOMAIN_CANDIDATE_DIST unset' })`, () => {
  beforeAll(async() => {
    fixture = await new LegacyCryptoFixtureStore().read();
    kit = new DomainKit(await import(/* @vite-ignore */ pathToFileURL(CANDIDATE).href) as Domain);
  });

  it('users.kdf: DesktopLocalKdfRecord reads the current, password-changed and legacy flat shapes', () => {
    // risk: legacy accounts — every stored kdf shape must yield the exact Argon2 salt and cost.
    for (const state of ['initial', 'afterPasswordChange', 'legacyFlatKdf'] as const) {
      const stored = Golden.user(fixture, state).kdf;
      const password = (stored.password ?? stored) as { salt: string; parameters: Params };
      expect(kit.kdf(stored)).toEqual({ alg: 'argon2id13', salt: password.salt, memoryBytes: password.parameters.memoryBytes, ops: password.parameters.operations });
    }
    expect(kit.domain.DesktopLocalKdfRecord.parse(Golden.user(fixture, 'legacyFlatKdf').kdf).isLegacyFlat).toBe(true);
    // Desktop upgrades the legacy flat shape on unlock to exactly the current JSON (see LegacyCryptoGolden.spec.ts).
    const upgraded = kit.domain.DesktopLocalKdfRecord.forPassword(kit.kdf(Golden.user(fixture, 'legacyFlatKdf').kdf)).toJSON();
    expect(upgraded).toEqual(Golden.user(fixture).kdf);
  });

  it('users login hash + verifier: DesktopLocalCredential verifies the golden password and rejects a wrong one', async() => {
    // risk: authentication — S7 must accept exactly the stored scrypt verifier.
    const user = Golden.user(fixture);
    const credential = kit.credential();
    const master = credential.deriveMasterKey(fixture.secrets.password, kit.kdf(user.kdf));
    const today = await deriveMasterKey(fixture.secrets.password, (user.kdf.password as { salt: string }).salt, (user.kdf.password as { parameters: Params }).parameters);
    expect(Golden.sha256(master)).toBe(Golden.sha256(today.key));
    expect(credential.loginHash(master)).toBe(await deriveLoginHash(today.key));
    expect(credential.verify(master, Golden.bytes(user.login_hash_salt), Golden.bytes(user.login_hash_verifier))).toBe(true);
    const wrong = credential.deriveMasterKey(`${ fixture.secrets.password }x`, kit.kdf(user.kdf));
    expect(credential.verify(wrong, Golden.bytes(user.login_hash_salt), Golden.bytes(user.login_hash_verifier))).toBe(false);
    // Writer parity: the same verifier salt gives the same verifier bytes.
    const writer = kit.credential(new ScriptedRandom(Golden.bytes(user.login_hash_salt)));
    const created = writer.createVerifier(master);
    expect(Buffer.from(created.verifier).equals(Buffer.from(Golden.bytes(user.login_hash_verifier)))).toBe(true);
  }, 120_000);

  it('users.encrypted_user_key + encrypted_private_key: DesktopLocalCredential opens both and reseals byte-for-byte', async() => {
    // risk: crypto/data integrity — the user key and X25519 identity must come out identical; no rewrap needed.
    const user = Golden.user(fixture);
    const credential = kit.credential();
    const master = credential.deriveMasterKey(fixture.secrets.password, kit.kdf(user.kdf));
    const userKey = credential.openUserKey(master, user.encrypted_user_key);
    expect(Golden.sha256(userKey)).toBe(fixture.userKeySha256);
    const privateKey = credential.openPrivateKey(userKey, user.encrypted_private_key);
    expect(Buffer.from(privateKey).equals(Buffer.from(await unwrapUserPrivateKey(user.encrypted_private_key as EncryptedEnvelope, await Golden.userKey(fixture))))).toBe(true);
    expect(Buffer.from(kit.crypto.x25519PublicKey(privateKey)).toString('base64url')).toBe(user.public_key);

    // Writer parity: the credential draws each wrap nonce from its own random source.
    expect(kit.credential(new ScriptedRandom(Golden.b64u(user.encrypted_user_key.nonce))).sealUserKey(master, userKey)).toEqual(user.encrypted_user_key);
    expect(kit.credential(new ScriptedRandom(Golden.b64u(user.encrypted_private_key.nonce))).sealPrivateKey(userKey, privateKey)).toEqual(user.encrypted_private_key);
  }, 120_000);

  it('users wrong password: DesktopLocalCredential refuses to open the user key wrap', () => {
    // risk: authentication — a wrong password must never produce a user key.
    const user = Golden.user(fixture);
    const credential = kit.credential();
    const wrong = credential.deriveMasterKey(`${ fixture.secrets.password }x`, kit.kdf(user.kdf));
    expect(() => credential.openUserKey(wrong, user.encrypted_user_key)).toThrow();
  }, 120_000);

  it('items ciphertext: LocalItemCipher opens every golden item to the exact plaintext and reseals byte-for-byte', async() => {
    // risk: crypto/data integrity — every existing item must open unchanged; S7 must not need to re-encrypt.
    const userKey = await Golden.userKey(fixture);
    const cipher = new kit.domain.LocalItemCipher(kit.wraps, kit.domain.WebCryptoRandomSource.fromGlobal());
    for (const row of Golden.items(fixture)) {
      const context = { itemId: row.id, ownerId: row.owner_user_id };
      const item = { version: 1, encryptedItemKey: row.encrypted_item_key, ciphertext: row.ciphertext };
      expect(cipher.openText(item, userKey, context)).toBe(fixture.plaintexts[row.id]);

      const itemKey = kit.wraps.open(userKey, row.encrypted_item_key, kit.domain.LocalItemCipher.associatedData('key', context));
      // Random draws in Desktop's order: item key (32), key-wrap nonce (24), ciphertext nonce (24).
      const replay = new kit.domain.LocalItemCipher(kit.wraps, new ScriptedRandom(itemKey, Golden.b64u(row.encrypted_item_key.nonce), Golden.b64u(row.ciphertext.nonce)));
      expect(replay.seal(fixture.plaintexts[row.id], userKey, context)).toEqual(item);
    }
  }, 120_000);

  it('items tamper: LocalItemCipher refuses a flipped ciphertext byte', async() => {
    // risk: crypto integrity — corrupted items must fail closed.
    const userKey = await Golden.userKey(fixture);
    const cipher = new kit.domain.LocalItemCipher(kit.wraps, kit.domain.WebCryptoRandomSource.fromGlobal());
    const row = Golden.items(fixture)[0];
    const bytes = Buffer.from(row.ciphertext.ciphertext, 'base64url');
    bytes[0] ^= 1;
    const tampered = { version: 1, encryptedItemKey: row.encrypted_item_key, ciphertext: { ...row.ciphertext, ciphertext: bytes.toString('base64url') } };
    expect(() => cipher.openText(tampered, userKey, { itemId: row.id, ownerId: row.owner_user_id })).toThrow();
  }, 120_000);

  it('recovery row: DesktopLocalRecovery opens the golden recovery code and rewrites the identical row', async() => {
    // risk: account recovery — an existing recovery code must keep working after S7.
    const row = Golden.recovery(fixture);
    const credential = kit.credential();
    const recovery = new kit.domain.DesktopLocalRecovery(credential, kit.wraps, kit.domain.WebCryptoRandomSource.fromGlobal());
    const domainRow = { recoverySalt: row.recovery_salt, recoveryVerifier: row.recovery_verifier, encryptedUserKey: row.encrypted_user_key };
    expect(Golden.sha256(recovery.open(domainRow, fixture.secrets.recoveryCode))).toBe(fixture.userKeySha256);
    expect(() => recovery.open(domainRow, `${ fixture.secrets.recoveryCode }x`)).toThrow();

    const metadata = JSON.parse(row.recovery_salt) as { kdf: string; verifier: string };
    const draws = new ScriptedRandom(Golden.b64u(metadata.kdf), Golden.b64u(metadata.verifier), Golden.b64u(row.encrypted_user_key.nonce));
    const writer = new kit.domain.DesktopLocalRecovery(kit.credential(draws), kit.wraps, draws);
    expect(writer.configure(await Golden.userKey(fixture), fixture.secrets.recoveryCode)).toEqual(domainRow);
  }, 120_000);

  it('backup file: BackupEnvelopeCodec decodes the golden backup to today\'s exact payload and re-encodes it byte-for-byte', async() => {
    // risk: backup/restore — an old backup file must open, and S7 must write the same envelope format.
    const codec = new kit.domain.BackupEnvelopeCodec(kit.crypto, kit.wraps, kit.domain.WebCryptoRandomSource.fromGlobal());
    const clear = codec.decode(fixture.backup, fixture.secrets.backupPassword) as Uint8Array;
    const today = await deriveMasterKey(fixture.secrets.backupPassword, fixture.backup.salt, fixture.backup.parameters);
    expect(Buffer.from(clear).equals(Buffer.from(await decryptWithKey(fixture.backup.envelope, today.key, 'sulla:local-backup:v1')))).toBe(true);
    const payload = JSON.parse(Buffer.from(clear).toString('utf8')) as { version: number; user: { id: string; encrypted_user_key: unknown }; items: Array<{ id: string; ciphertext: unknown }> };
    expect(payload.user.id).toBe(fixture.userId);
    expect(payload.user.encrypted_user_key).toEqual(Golden.user(fixture).encrypted_user_key);
    expect(payload.items.map(item => item.id).sort()).toEqual(Golden.items(fixture).map(item => item.id).sort());
    expect(() => codec.decode(fixture.backup, `${ fixture.secrets.backupPassword }x`)).toThrow();

    const replay = new kit.domain.BackupEnvelopeCodec(kit.crypto, kit.wraps, kit.domain.WebCryptoRandomSource.fromGlobal());
    expect(replay.encode(clear, fixture.secrets.backupPassword, {
      salt: Golden.b64u(fixture.backup.salt), nonce: Golden.b64u(fixture.backup.envelope.nonce),
      memoryBytes: fixture.backup.parameters.memoryBytes, operations: fixture.backup.parameters.operations,
    })).toEqual(fixture.backup);
  }, 120_000);

  it('password change: the new wrap and the preserved wrap-history row open to the same user key', () => {
    // risk: password change — both the current and the restore-point wrap must hold the original user key.
    const credential = kit.credential();
    const changed = Golden.user(fixture, 'afterPasswordChange');
    const current = credential.deriveMasterKey(fixture.secrets.changedPassword, kit.kdf(changed.kdf));
    expect(credential.verify(current, Golden.bytes(changed.login_hash_salt), Golden.bytes(changed.login_hash_verifier))).toBe(true);
    expect(Golden.sha256(credential.openUserKey(current, changed.encrypted_user_key))).toBe(fixture.userKeySha256);

    const history = fixture.states.afterPasswordChange.wrapHistory[0] as unknown as UserRow;
    const old = credential.deriveMasterKey(fixture.secrets.password, kit.kdf(history.kdf));
    expect(credential.verify(old, Golden.bytes(history.login_hash_salt), Golden.bytes(history.login_hash_verifier))).toBe(true);
    expect(Golden.sha256(credential.openUserKey(old, history.encrypted_user_key))).toBe(fixture.userKeySha256);
  }, 120_000);

  it('unlock/lock: VaultSession holds the golden keys, serves item opens and forgets them on lock', async() => {
    // risk: session lifecycle — after lock no operation may reach the user key.
    const user = Golden.user(fixture);
    const credential = kit.credential();
    const userKey = credential.openUserKey(credential.deriveMasterKey(fixture.secrets.password, kit.kdf(user.kdf)), user.encrypted_user_key);
    const privateKey = credential.openPrivateKey(userKey, user.encrypted_private_key);
    const session = new kit.domain.VaultSession(new kit.domain.InMemoryVaultKeyHolder(), { dispatch: async() => undefined });
    await session.unlock(userKey, privateKey);
    const cipher = new kit.domain.LocalItemCipher(kit.wraps, kit.domain.WebCryptoRandomSource.fromGlobal());
    const row = Golden.items(fixture)[0];
    const opened = await session.withUserKey((key: Uint8Array) => cipher.openText({ version: 1, encryptedItemKey: row.encrypted_item_key, ciphertext: row.ciphertext }, key, { itemId: row.id, ownerId: row.owner_user_id }));
    expect(opened).toBe(fixture.plaintexts[row.id]);
    await session.lock();
    expect(await session.isUnlocked()).toBe(false);
    await expect(session.withUserKey(() => 'reached')).rejects.toThrow();
  }, 120_000);
});
