// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// ONE-SHOT generator for the legacy local-vault crypto goldens (M3 S7a). Skipped unless
// SULLA_LEGACY_CRYPTO_REGENERATE=1. The goldens are FROZEN: regenerating replaces every salt, nonce and key,
// which would make the byte-for-byte guard meaningless. Only regenerate to add a new format, and say so in
// the PR. See services/sulla-vault/test/fixtures/legacy-crypto/README.md.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { decryptItemText, deriveMasterKey, unwrapUserKey, type VaultItemPlaintext } from '@sulla/vault-crypto';
import { LegacyCryptoFixtureStore, type LegacyCryptoFixture, type LegacyVaultState } from '../../Support/LegacyCryptoFixture';
import { LegacyVaultAuthorityDriver, LegacyVaultDatabase } from '../../Support/LegacyVaultHarness';

const SECRETS = {
  password:        'synthetic-legacy-password-1 (fixture only)',
  changedPassword: 'synthetic-legacy-password-2 (fixture only)',
  recoveryCode:    'synthetic-recovery-code-0001',
  backupPassword:  'synthetic-backup-password (fixture only)',
} as const;

const POLICY = { mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null } as const;

const ITEMS: VaultItemPlaintext[] = [
  {
    type: 'login', name: 'Example login', favorite: true, username: 'owner@example.com', password: 'synthetic-site-password',
    totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://login.example.com', match: 'domain' }], notes: 'line one\nline two ✓',
    fields: [{ name: 'pin', value: '0000', hidden: true }], agentPolicy: { ...POLICY, agents: [], sites: [] },
  } as unknown as VaultItemPlaintext,
  { type: 'note', name: 'Example secure note', notes: 'Synthetic note body: ünïcödé, emoji 🔐, quotes "q" and \\ backslash', agentPolicy: { ...POLICY } } as unknown as VaultItemPlaintext,
  {
    type: 'card', name: 'Example card', card: { holder: 'Example Owner', brand: 'Visa', number: '4111111111111111', expMonth: '12', expYear: '2030', code: '123' },
    agentPolicy: { ...POLICY },
  } as unknown as VaultItemPlaintext,
  {
    // Local items have no file attachments; Bitwarden attachment metadata is kept verbatim inside the ciphertext.
    type: 'login', name: 'Imported login with attachment metadata', username: 'imported@example.com', password: 'synthetic-imported',
    sourceMetadata: { source: 'bitwarden', sourceId: 'bw-synthetic-1', attachments: [{ id: 'att-1', fileName: 'synthetic.txt', size: '12' }] },
    agentPolicy: { ...POLICY },
  } as unknown as VaultItemPlaintext,
];

class LegacyFixtureGenerator {
  private readonly store = new LegacyCryptoFixtureStore();

  constructor(private readonly database: LegacyVaultDatabase, private readonly driver: LegacyVaultAuthorityDriver) {}

  async run(): Promise<LegacyCryptoFixture> {
    await this.driver.unlock(SECRETS.password); // first unlock creates the vault (users row)
    const userId = this.driver.status().principalId!;
    const ids: string[] = [];
    for (const item of ITEMS) ids.push((await this.driver.save({ item })).id);
    // A second revision of the first login exercises the update path (revision 2, re-sealed item key).
    await this.driver.save({ id: ids[0], revision: 1, item: { ...ITEMS[0], password: 'synthetic-site-password-rotated' } as VaultItemPlaintext });
    await this.driver.configureRecovery(SECRETS.recoveryCode);
    const backup = await this.driver.exportBackup(SECRETS.backupPassword);
    const initial = await this.state(userId);
    await this.driver.changePassword(SECRETS.password, SECRETS.changedPassword);
    const afterPasswordChange = await this.state(userId);
    const plaintexts = await this.plaintexts(initial);
    const userKey = await this.userKey(initial);

    return {
      format:        'sulla-desktop-legacy-local-crypto',
      version:       1,
      generatedAt:   new Date().toISOString(),
      generatedFrom: {
        baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        producers:  [
          'LocalVaultAuthority.unlockHumanSession (first unlock creates users row)', 'LocalVaultAuthority.saveHumanItem',
          'LocalVaultAuthority.configureHumanRecovery', 'LocalVaultAuthority.exportHumanBackup', 'LocalVaultAuthority.changeHumanPassword',
          '@sulla/vault-crypto (packages/vault-crypto) deriveMasterKey/encryptWithKey/encryptItem', 'services/sulla-vault/src/auth.ts makeLoginVerifier',
        ],
      },
      secrets:       { ...SECRETS },
      userId,
      userKeySha256: createHash('sha256').update(userKey).digest('hex'),
      plaintexts,
      states:        { initial, afterPasswordChange, legacyFlatKdf: this.legacyFlat(initial) },
      backup:        backup as LegacyCryptoFixture['backup'],
    };
  }

  private async state(userId: string): Promise<LegacyVaultState> {
    return {
      users:                 await this.store.dump(this.database.db, 'users', userId),
      items:                 await this.store.dump(this.database.db, 'items', userId),
      recovery:              await this.store.dump(this.database.db, 'recovery', userId),
      wrapHistory:           await this.store.dump(this.database.db, 'wrapHistory', userId),
      userKeyMaterialSha256: await this.database.userKeyMaterialDigest(userId),
    };
  }

  /**
   * The pre-`authority/version/password` users.kdf shape ({salt, parameters} at the top level) that older
   * Desktop builds stored. Today's code cannot write it, so it is the `initial` row with only the kdf JSON
   * reshaped; the wrap, verifier and salt bytes are identical, so it opens with the same password.
   */
  private legacyFlat(initial: LegacyVaultState): LegacyVaultState {
    const user = structuredClone(initial.users[0]);
    const password = (user.kdf as { password: { salt: string; parameters: unknown } }).password;
    user.kdf = { salt: password.salt, parameters: password.parameters };
    return { ...structuredClone(initial), users: [user], userKeyMaterialSha256: '' };
  }

  private async userKey(state: LegacyVaultState): Promise<Uint8Array> {
    const user = state.users[0] as { kdf: { password: { salt: string; parameters: { memoryBytes: number; operations: number } } }; encrypted_user_key: Parameters<typeof unwrapUserKey>[0] };
    const master = await deriveMasterKey(SECRETS.password, user.kdf.password.salt, user.kdf.password.parameters);
    return unwrapUserKey(user.encrypted_user_key, master.key);
  }

  private async plaintexts(state: LegacyVaultState): Promise<Record<string, string>> {
    const userKey = await this.userKey(state);
    const out: Record<string, string> = {};
    for (const row of state.items as Array<{ id: string; owner_user_id: string; ciphertext: never; encrypted_item_key: never }>) {
      out[row.id] = await decryptItemText({ version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, userKey, { itemId: row.id, ownerId: row.owner_user_id });
    }
    return out;
  }
}

describe.skipIf(process.env.SULLA_LEGACY_CRYPTO_REGENERATE !== '1')('legacy local-vault crypto golden generator', () => {
  it('writes services/sulla-vault/test/fixtures/legacy-crypto/legacy-local-vault.json from today\'s code', async() => {
    const database = await new LegacyVaultDatabase().open();
    try {
      const fixture = await new LegacyFixtureGenerator(database, new LegacyVaultAuthorityDriver(database.db)).run();
      const legacy = fixture.states.legacyFlatKdf;
      // The legacy-flat digest is taken from a seeded copy so the test reads the same canonical jsonb text.
      const flatDb = await new LegacyVaultDatabase().open();
      try {
        await new LegacyCryptoFixtureStore().seed(flatDb.db, legacy);
        legacy.userKeyMaterialSha256 = await flatDb.userKeyMaterialDigest(fixture.userId);
      } finally { await flatDb.close() }
      expect(Object.keys(fixture.plaintexts)).toHaveLength(ITEMS.length);
      expect(fixture.states.afterPasswordChange.wrapHistory).toHaveLength(1);
      await new LegacyCryptoFixtureStore().write(fixture);
    } finally {
      await database.close();
    }
  }, 120_000);
});
