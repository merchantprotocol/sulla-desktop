// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// M3 S7: business rules of the Desktop vault's domain-backed local crypto (services/sulla-vault/src/localCrypto).
// The S7a goldens (Characterization/Vault/LegacyCryptoGolden.spec.ts) prove old rows still open. This spec
// covers the seams S7 added: everything the new code WRITES must still open with the old
// @sulla/vault-crypto + auth.ts readers (so a downgraded app reads it), and the users.kdf / backup
// adapters keep Desktop's exact rules.

import { beforeAll, describe, expect, it } from 'vitest';

import { NobleScryptFunction } from '@sulla/domain';
import {
  decryptItemText,
  decryptWithKey,
  deriveLoginHash,
  deriveMasterKey,
  encryptItem,
  unwrapUserKey,
  unwrapUserPrivateKey,
  type EncryptedEnvelope,
} from '@sulla/vault-crypto';
import { verifyLoginHash } from '../../../../../../services/sulla-vault/src/auth';
import { DesktopHumanBackup } from '../../../../../../services/sulla-vault/src/localCrypto/DesktopHumanBackup';
import type { LocalVaultCrypto } from '../../../../../../services/sulla-vault/src/localCrypto/LocalVaultCrypto';
import { LocalVaultCryptoProvider } from '../../../../../../services/sulla-vault/src/localCrypto/LocalVaultCryptoProvider';
import { NodeScryptFunction } from '../../../../../../services/sulla-vault/src/localCrypto/NodeScryptFunction';

/** Synthetic fixtures only. */
class LocalCryptoScenario {
  static readonly PASSWORD = 'synthetic local password';
  static readonly OWNER = '0b6c3f2e-1111-4a4a-9a9a-000000000001';
  static readonly ITEM = '0b6c3f2e-2222-4a4a-9a9a-000000000002';

  constructor(readonly crypto: LocalVaultCrypto) {}

  static async create(): Promise<LocalCryptoScenario> {
    return new LocalCryptoScenario(await new LocalVaultCryptoProvider().get());
  }

  /** A password master key exactly as today's unlock derives it for a fresh vault. */
  freshMasterKey(): { masterKey: Uint8Array; salt: string; parameters: { memoryBytes: number; operations: number } } {
    const kdf = this.crypto.credential.newPasswordKdf();
    return {
      masterKey:  this.crypto.credential.deriveMasterKey(LocalCryptoScenario.PASSWORD, kdf),
      salt:       kdf.salt,
      parameters: { memoryBytes: kdf.memoryBytes, operations: kdf.ops },
    };
  }
}

let scenario: LocalCryptoScenario;

describe('Desktop local vault crypto on @sulla/domain (M3 S7)', () => {
  beforeAll(async() => { scenario = await LocalCryptoScenario.create() });

  it('NodeScryptFunction gives the same verifier bytes as the domain NobleScryptFunction and auth.ts', () => {
    // risk: authentication — a native scrypt with different cost would lock every user out of an existing vault.
    const password = new TextEncoder().encode('login-hash-text');
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const native = new NodeScryptFunction().derive(password, salt, 32);
    expect(Buffer.from(native).equals(Buffer.from(new NobleScryptFunction().derive(password, salt, 32)))).toBe(true);
    expect(verifyLoginHash('login-hash-text', salt, native)).toBe(true);
    expect(verifyLoginHash('login-hash-text', salt, new NodeScryptFunction().derive(new TextEncoder().encode('other'), salt, 32))).toBe(false);
  });

  it('a new vault account opens with the old vault-crypto readers and the old login verifier', async() => {
    // risk: data integrity / downgrade — a vault created by S7 must open on a build that still uses @sulla/vault-crypto.
    const fresh = scenario.freshMasterKey();
    const account = scenario.crypto.createAccount(fresh.masterKey);
    const legacyMaster = await deriveMasterKey(LocalCryptoScenario.PASSWORD, fresh.salt, fresh.parameters);
    expect(Buffer.from(legacyMaster.key).equals(Buffer.from(fresh.masterKey))).toBe(true);

    const userKey = await unwrapUserKey(account.encryptedUserKey as EncryptedEnvelope, legacyMaster.key);
    expect(Buffer.from(userKey).equals(Buffer.from(account.userKey))).toBe(true);
    const privateKey = await unwrapUserPrivateKey(account.encryptedPrivateKey as EncryptedEnvelope, userKey);
    expect(Buffer.from(privateKey).equals(Buffer.from(account.privateKey))).toBe(true);
    expect(verifyLoginHash(await deriveLoginHash(legacyMaster.key), account.verifier.salt, account.verifier.verifier)).toBe(true);
    expect(Buffer.isBuffer(account.verifier.salt) && Buffer.isBuffer(account.verifier.verifier)).toBe(true);
    expect(account.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The verifier rejects any other master key.
    const other = scenario.freshMasterKey();
    expect(scenario.crypto.verifyPassword(other.masterKey, account.verifier.salt, account.verifier.verifier)).toBe(false);
  }, 120_000);

  it('users.kdf: reads current, legacy flat and cache-only shapes; unreadable values are treated as no password', () => {
    // risk: legacy accounts — the flat shape must be flagged for the one-time upgrade; nothing else is.
    const salt = 'AAECAwQFBgcICQoLDA0ODw';
    const flat = scenario.crypto.readKdf({ salt, parameters: { memoryBytes: 67_108_864, operations: 3 } });
    expect(flat?.isLegacyFlat).toBe(true);
    expect(flat?.passwordKdf()).toEqual({ alg: 'argon2id13', salt, memoryBytes: 67_108_864, ops: 3 });
    const flatNoParameters = scenario.crypto.readKdf({ salt });
    expect(flatNoParameters?.passwordKdf()).toEqual({ alg: 'argon2id13', salt, memoryBytes: 67_108_864, ops: 3 });

    const current = scenario.crypto.readKdf({ authority: 'container', version: 1, cloudUserId: 'cloud-1', password: { salt, parameters: { memoryBytes: 67_108_864, operations: 3 } } });
    expect(current?.isLegacyFlat).toBe(false);
    expect(current?.cloudUserId).toBe('cloud-1');

    expect(scenario.crypto.readKdf({ authority: 'container', version: 1 })?.passwordKdf()).toBeUndefined();
    expect(scenario.crypto.readKdf(null)).toBeUndefined();
    expect(scenario.crypto.readKdf({ password: { salt: '' } })).toBeUndefined();
  });

  it('users.kdf: the column Desktop writes for a password is the current shape without a Cloud binding', () => {
    // risk: data integrity — password change/recovery wrote exactly this JSON before S7; S7 must not add or drop fields.
    const kdf = { alg: 'argon2id13' as const, salt: 'AAECAwQFBgcICQoLDA0ODw', memoryBytes: 67_108_864, ops: 3 };
    expect(JSON.stringify(scenario.crypto.kdfColumn(kdf))).toBe(JSON.stringify({
      authority: 'container', version: 1, password: { salt: kdf.salt, parameters: { memoryBytes: 67_108_864, operations: 3 } },
    }));
  });

  it('items: a sealed item opens with the old decryptItemText, an old item opens here, and the AAD binds owner + item', async() => {
    // risk: crypto/data integrity — items are the user's secrets; a swapped row must never open as another item.
    const userKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
    const context = { itemId: LocalCryptoScenario.ITEM, ownerId: LocalCryptoScenario.OWNER };
    const plaintext = JSON.stringify({ type: 'login', name: 'Example', username: 'user@example.com', password: 'synthetic-secret-🔐' });

    const sealed = scenario.crypto.sealItem(plaintext, userKey, context);
    expect(await decryptItemText(sealed, userKey, context)).toBe(plaintext);

    const legacy = await encryptItem(plaintext, userKey, context);
    expect(scenario.crypto.openItemText({ version: 1, encryptedItemKey: legacy.encryptedItemKey, ciphertext: legacy.ciphertext }, userKey, context)).toBe(plaintext);

    expect(() => scenario.crypto.openItemText(sealed, userKey, { ...context, itemId: '0b6c3f2e-3333-4a4a-9a9a-000000000003' })).toThrow();
    expect(() => scenario.crypto.openItemText(sealed, userKey, { ...context, ownerId: '0b6c3f2e-4444-4a4a-9a9a-000000000004' })).toThrow();
    expect(() => scenario.crypto.openItemText(sealed, Uint8Array.from({ length: 32 }, () => 7), context)).toThrow();
  });

  it('recovery rotation: the rotated row opens with the old reader and the returned key; a wrong key is refused', async() => {
    // risk: account recovery — a rotated recovery key must be the only thing that opens the new recovery row.
    const userKey = Uint8Array.from({ length: 32 }, (_, index) => index * 3);
    const rotation = scenario.crypto.recovery.rotate(userKey);
    expect(rotation.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const metadata = JSON.parse(rotation.row.recoverySalt) as { kdf: string; verifier: string; parameters: { memoryBytes: number; operations: number } };
    expect(Object.keys(metadata)).toEqual(['kdf', 'verifier', 'parameters']);
    const legacy = await deriveMasterKey(rotation.recoveryKey, metadata.kdf, metadata.parameters);
    expect(verifyLoginHash(await deriveLoginHash(legacy.key), Buffer.from(metadata.verifier, 'base64url'), Buffer.from(rotation.row.recoveryVerifier, 'base64url'))).toBe(true);
    const opened = await decryptWithKey(rotation.row.encryptedUserKey as EncryptedEnvelope, legacy.key, 'sulla:recovery-user-key:v1');
    expect(Buffer.from(opened).equals(Buffer.from(userKey))).toBe(true);

    expect(Buffer.from(scenario.crypto.recovery.open(rotation.row, rotation.recoveryKey)).equals(Buffer.from(userKey))).toBe(true);
    expect(() => scenario.crypto.recovery.open(rotation.row, `${ rotation.recoveryKey }x`)).toThrow();
  }, 120_000);

  it('backup: a sealed backup opens with the old reader to the exact payload JSON, including Buffer#toJSON bytea', async() => {
    // risk: backup/restore — a backup written by S7 must restore on an older build and keep bytea columns intact.
    const salt = Buffer.from(Uint8Array.from({ length: 16 }, (_, index) => index));
    const contents = { user: { id: LocalCryptoScenario.OWNER, login_hash_salt: salt }, items: [{ id: LocalCryptoScenario.ITEM, revision: 2 }], recovery: null };
    const envelope = scenario.crypto.backups.seal(contents, 'synthetic backup password');
    expect(Object.keys(envelope)).toEqual(['version', 'salt', 'parameters', 'envelope']);
    expect(envelope.parameters).toEqual({ memoryBytes: 67_108_864, operations: 3 });

    const legacy = await deriveMasterKey('synthetic backup password', envelope.salt, envelope.parameters);
    const clear = Buffer.from(await decryptWithKey(envelope.envelope as EncryptedEnvelope, legacy.key, 'sulla:local-backup:v1')).toString('utf8');
    expect(clear).toBe(JSON.stringify({ version: 1, ...contents }));

    const restored = scenario.crypto.backups.open(envelope, 'synthetic backup password');
    expect(restored.user.id).toBe(LocalCryptoScenario.OWNER);
    expect(DesktopHumanBackup.bytea(restored.user.login_hash_salt).equals(salt)).toBe(true);
  }, 120_000);

  it('backup: a wrong password, a foreign payload or a malformed byte field is refused', () => {
    // risk: backup/restore — a restore must never import a payload it cannot fully trust.
    const envelope = scenario.crypto.backups.seal({ user: { id: LocalCryptoScenario.OWNER }, items: [], recovery: null }, 'synthetic backup password');
    expect(() => scenario.crypto.backups.open(envelope, 'wrong backup password')).toThrow();
    expect(() => scenario.crypto.backups.open({ ...envelope, version: 2 }, 'synthetic backup password')).toThrow();

    const foreign = scenario.crypto.backups.seal({ user: {} as never, items: [], recovery: null }, 'synthetic backup password');
    expect(() => scenario.crypto.backups.open(foreign, 'synthetic backup password')).toThrow('invalid backup payload');

    expect(() => DesktopHumanBackup.bytea('not-bytes')).toThrow();
    expect(() => DesktopHumanBackup.bytea({ type: 'Buffer' })).toThrow();
  }, 120_000);
});
