// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// M3 S7a: the frozen legacy local-vault goldens must keep opening through the REAL LocalVaultAuthority on a
// real Postgres, byte-for-byte, and reading must never rewrite key material. This is the safety net for S7
// moving the vault crypto onto @sulla/domain. Fixture: services/sulla-vault/test/fixtures/legacy-crypto/.

import { createHash } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { decryptItemText, deriveMasterKey, unwrapUserKey, type EncryptedEnvelope } from '@sulla/vault-crypto';
import { LegacyCryptoFixtureStore, type LegacyCryptoFixture, type LegacyVaultState } from '../../Support/LegacyCryptoFixture';
import { LegacyVaultAuthorityDriver, LegacyVaultDatabase } from '../../Support/LegacyVaultHarness';

interface StoredUser { kdf: { password?: { salt: string; parameters: { memoryBytes: number; operations: number } }; salt?: string; parameters?: { memoryBytes: number; operations: number } }; encrypted_user_key: EncryptedEnvelope }

class LegacyVaultScenario {
  readonly store = new LegacyCryptoFixtureStore();
  database: LegacyVaultDatabase | null = null;
  driver: LegacyVaultAuthorityDriver | null = null;

  async open(state?: LegacyVaultState): Promise<{ database: LegacyVaultDatabase; driver: LegacyVaultAuthorityDriver }> {
    const database = await new LegacyVaultDatabase().open();
    this.database = database;
    if (state) await this.store.seed(database.db, state);
    this.driver = new LegacyVaultAuthorityDriver(database.db);
    return { database, driver: this.driver };
  }

  async close(): Promise<void> {
    await this.driver?.authority.lock().catch(() => undefined);
    await this.database?.close();
    this.database = null;
    this.driver = null;
  }

  /** sha256 of the user key that `password` unwraps from the stored users row (proves which key a wrap holds). */
  async storedUserKeySha256(userId: string, password: string): Promise<string> {
    const row = (await this.database!.db.query<StoredUser>('SELECT kdf, encrypted_user_key FROM users WHERE id=$1', [userId])).rows[0];
    const kdf = row.kdf.password ?? { salt: row.kdf.salt!, parameters: row.kdf.parameters! };
    const master = await deriveMasterKey(password, kdf.salt, kdf.parameters);
    const userKey = await unwrapUserKey(row.encrypted_user_key, master.key);
    return createHash('sha256').update(userKey).digest('hex');
  }
}

class RowDigests {
  static async of(database: LegacyVaultDatabase, userId: string): Promise<{ user: string; items: string; recovery: string }> {
    return { user: await database.userRowDigest(userId), items: await database.itemRowsDigest(userId), recovery: await database.recoveryRowDigest(userId) };
  }
}

let fixture: LegacyCryptoFixture;
const scenario = new LegacyVaultScenario();

beforeAll(async() => { fixture = await new LegacyCryptoFixtureStore().read() });
afterEach(async() => { await scenario.close() });

describe('legacy local vault goldens through LocalVaultAuthority (real Postgres)', () => {
  it('seeds the golden users row byte-for-byte', async() => {
    // risk: data integrity — the harness must store exactly the golden bytes, or every other assertion is moot.
    const { database } = await scenario.open(fixture.states.initial);
    expect(await database.userKeyMaterialDigest(fixture.userId)).toBe(fixture.states.initial.userKeyMaterialSha256);
  });

  it('unlocks with the golden password and lists + reveals every item to its exact plaintext', async() => {
    // risk: crypto/data integrity — existing items must decrypt to exactly what was saved.
    const { driver } = await scenario.open(fixture.states.initial);
    await driver.unlock(fixture.secrets.password);
    expect(driver.status()).toMatchObject({ unlocked: true, principalId: fixture.userId });

    const listed = await driver.list();
    expect(listed.map(item => item.id).sort()).toEqual(Object.keys(fixture.plaintexts).sort());
    for (const [id, plaintext] of Object.entries(fixture.plaintexts)) {
      const revealed = await driver.reveal(id);
      expect(JSON.stringify(revealed.item)).toBe(plaintext);
      expect(revealed.revision).toBe(Number(fixture.states.initial.items.find(row => row.id === id)!.revision));
    }
  }, 60_000);

  it('never rewrites the users key row, items or recovery row on unlock, list, reveal, lock and re-unlock', async() => {
    // risk: owner rule — reading the vault must not re-encrypt; the local users key row never changes on read.
    const { database, driver } = await scenario.open(fixture.states.initial);
    const before = await RowDigests.of(database, fixture.userId);

    await driver.unlock(fixture.secrets.password);
    await driver.list();
    for (const id of Object.keys(fixture.plaintexts)) await driver.reveal(id);
    await driver.lock();
    await driver.unlock(fixture.secrets.password);
    await driver.list();

    expect(await RowDigests.of(database, fixture.userId)).toEqual(before);
    expect(await database.userKeyMaterialDigest(fixture.userId)).toBe(fixture.states.initial.userKeyMaterialSha256);
  }, 60_000);

  it('rejects a wrong password, stays locked and leaves every row untouched', async() => {
    // risk: authentication — a wrong password must never unlock or write anything.
    const { database, driver } = await scenario.open(fixture.states.initial);
    const before = await RowDigests.of(database, fixture.userId);
    await expect(driver.unlock(`${ fixture.secrets.password }x`)).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(driver.status().unlocked).toBe(false);
    expect(await RowDigests.of(database, fixture.userId)).toEqual(before);
  }, 60_000);

  it('refuses a tampered item ciphertext and a tampered user-key wrap', async() => {
    // risk: crypto integrity — corrupted bytes must fail closed, never yield plaintext.
    const tampered = structuredClone(fixture.states.initial);
    const item = tampered.items[0] as { id: string; ciphertext: { ciphertext: string } };
    item.ciphertext.ciphertext = LegacyCryptoBytes.flipFirst(item.ciphertext.ciphertext);
    const { driver } = await scenario.open(tampered);
    await driver.unlock(fixture.secrets.password);
    await expect(driver.reveal(item.id)).rejects.toThrow();
    await scenario.close();

    const badWrap = structuredClone(fixture.states.initial);
    const user = badWrap.users[0] as { encrypted_user_key: { ciphertext: string } };
    user.encrypted_user_key.ciphertext = LegacyCryptoBytes.flipFirst(user.encrypted_user_key.ciphertext);
    const second = await scenario.open(badWrap);
    await expect(second.driver.unlock(fixture.secrets.password)).rejects.toThrow();
    expect(second.driver.status().unlocked).toBe(false);
  }, 60_000);

  it('opens the vault with the golden recovery code, keeps the same user key and the recovery row', async() => {
    // risk: account recovery — an old recovery code must still open the same vault; the recovery wrap is not rewritten.
    const { database, driver } = await scenario.open(fixture.states.initial);
    const recoveryBefore = await database.recoveryRowDigest(fixture.userId);
    const nextPassword = 'synthetic-post-recovery-password';
    const result = await driver.recover(fixture.secrets.recoveryCode, nextPassword);
    expect(result).toMatchObject({ phase: 'unlocked' });
    for (const [id, plaintext] of Object.entries(fixture.plaintexts)) expect(JSON.stringify((await driver.reveal(id)).item)).toBe(plaintext);

    expect(await scenario.storedUserKeySha256(fixture.userId, nextPassword)).toBe(fixture.userKeySha256);
    expect(await database.recoveryRowDigest(fixture.userId)).toBe(recoveryBefore);
    const history = await database.db.query<{ reason: string; encrypted_user_key: unknown }>('SELECT reason, encrypted_user_key FROM local_vault_wrap_history WHERE user_id=$1', [fixture.userId]);
    expect(history.rows).toEqual([{ reason: 'recovery', encrypted_user_key: (fixture.states.initial.users[0] as { encrypted_user_key: unknown }).encrypted_user_key }]);
  }, 60_000);

  it('rejects a wrong recovery code without touching the users row', async() => {
    // risk: account recovery — a wrong code must not unlock or rewrap.
    const { database, driver } = await scenario.open(fixture.states.initial);
    const before = await database.userRowDigest(fixture.userId);
    await expect(driver.recover(`${ fixture.secrets.recoveryCode }x`, 'synthetic-post-recovery-password')).rejects.toMatchObject({ status: 401 });
    expect(driver.status().unlocked).toBe(false);
    expect(await database.userRowDigest(fixture.userId)).toBe(before);
  }, 60_000);

  it('restores the golden backup into an empty vault byte-for-byte and it unlocks with the original password', async() => {
    // risk: backup/restore — an old backup file must restore the exact key material and items.
    const { database, driver } = await scenario.open();
    await driver.importBackup(fixture.secrets.backupPassword, fixture.backup);

    expect(await database.userKeyMaterialDigest(fixture.userId)).toBe(fixture.states.initial.userKeyMaterialSha256);
    const items = await new LegacyCryptoFixtureStore().dump(database.db, 'items', fixture.userId);
    expect(items.map(LegacyCryptoBytes.itemCrypto)).toEqual(fixture.states.initial.items.map(LegacyCryptoBytes.itemCrypto));
    const recovery = await new LegacyCryptoFixtureStore().dump(database.db, 'recovery', fixture.userId);
    expect(recovery.map(LegacyCryptoBytes.recoveryCrypto)).toEqual(fixture.states.initial.recovery.map(LegacyCryptoBytes.recoveryCrypto));

    await driver.unlock(fixture.secrets.password);
    for (const [id, plaintext] of Object.entries(fixture.plaintexts)) expect(JSON.stringify((await driver.reveal(id)).item)).toBe(plaintext);
  }, 60_000);

  it('refuses the golden backup with a wrong backup password and imports nothing', async() => {
    // risk: backup confidentiality — a wrong password must not restore anything.
    const { database, driver } = await scenario.open();
    await expect(driver.importBackup(`${ fixture.secrets.backupPassword }x`, fixture.backup)).rejects.toMatchObject({ status: 400 });
    expect((await database.db.query('SELECT id FROM users')).rowCount).toBe(0);
  }, 60_000);

  it('after a password change opens only with the new password; the preserved old wrap still holds the same user key', async() => {
    // risk: password change — the new wrap must hold the same user key, the old password must stop working.
    const { database, driver } = await scenario.open(fixture.states.afterPasswordChange);
    await expect(driver.unlock(fixture.secrets.password)).rejects.toMatchObject({ status: 401 });
    await driver.unlock(fixture.secrets.changedPassword);
    for (const [id, plaintext] of Object.entries(fixture.plaintexts)) expect(JSON.stringify((await driver.reveal(id)).item)).toBe(plaintext);
    expect(await database.userKeyMaterialDigest(fixture.userId)).toBe(fixture.states.afterPasswordChange.userKeyMaterialSha256);

    const old = fixture.states.afterPasswordChange.wrapHistory[0] as { reason: string; kdf: StoredUser['kdf']; encrypted_user_key: EncryptedEnvelope };
    expect(old.reason).toBe('password_change');
    const master = await deriveMasterKey(fixture.secrets.password, old.kdf.password!.salt, old.kdf.password!.parameters);
    expect(createHash('sha256').update(await unwrapUserKey(old.encrypted_user_key, master.key)).digest('hex')).toBe(fixture.userKeySha256);
  }, 60_000);

  it('unlocks the legacy flat users.kdf shape and rewrites only the kdf column, never the wrap or verifier', async() => {
    // risk: legacy accounts — older kdf JSON must still open; today's code upgrades kdf JSON only (S7 must match).
    const { database, driver } = await scenario.open(fixture.states.legacyFlatKdf);
    const keyColumns = 'SELECT login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key FROM users WHERE id=$1';
    const before = (await database.db.query(keyColumns, [fixture.userId])).rows[0];
    await driver.unlock(fixture.secrets.password);
    for (const [id, plaintext] of Object.entries(fixture.plaintexts)) expect(JSON.stringify((await driver.reveal(id)).item)).toBe(plaintext);

    expect((await database.db.query(keyColumns, [fixture.userId])).rows[0]).toEqual(before);
    const kdf = (await database.db.query<{ kdf: unknown }>('SELECT kdf FROM users WHERE id=$1', [fixture.userId])).rows[0].kdf;
    expect(kdf).toEqual((fixture.states.initial.users[0] as { kdf: unknown }).kdf);
  }, 60_000);

  it('decrypts every golden item with today\'s @sulla/vault-crypto primitives to the exact plaintext bytes', async() => {
    // risk: crypto/data integrity — pins the exact UTF-8 bytes, not just a JSON round-trip.
    const user = fixture.states.initial.users[0] as unknown as StoredUser;
    const master = await deriveMasterKey(fixture.secrets.password, user.kdf.password!.salt, user.kdf.password!.parameters);
    const userKey = await unwrapUserKey(user.encrypted_user_key, master.key);
    expect(createHash('sha256').update(userKey).digest('hex')).toBe(fixture.userKeySha256);
    for (const row of fixture.states.initial.items as Array<{ id: string; owner_user_id: string; ciphertext: EncryptedEnvelope; encrypted_item_key: EncryptedEnvelope }>) {
      expect(await decryptItemText({ version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, userKey, { itemId: row.id, ownerId: row.owner_user_id }))
        .toBe(fixture.plaintexts[row.id]);
    }
  }, 60_000);
});

class LegacyCryptoBytes {
  /** Flip one bit of the first byte of a base64url value (stays valid base64url, same length). */
  static flipFirst(value: string): string {
    const bytes = Buffer.from(value, 'base64url');
    bytes[0] ^= 0x01;
    return bytes.toString('base64url');
  }

  static itemCrypto(row: Record<string, unknown>) {
    return { id: row.id, owner: row.owner_user_id, type: row.item_type, ciphertext: row.ciphertext, key: row.encrypted_item_key, policy: row.agent_policy, revision: Number(row.revision) };
  }

  static recoveryCrypto(row: Record<string, unknown>) {
    return { user: row.user_id, salt: row.recovery_salt, verifier: row.recovery_verifier, wrap: row.encrypted_user_key };
  }
}
