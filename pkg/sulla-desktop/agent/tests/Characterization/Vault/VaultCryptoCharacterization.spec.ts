// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  decryptItemText,
  deriveMasterKey,
  openFilesKeyBundle,
  sealFilesKeyBundle,
  unwrapUserKey,
  generateX25519RecipientKeyPair,
} from '../../../../../../packages/vault-crypto/src/index';

interface KatRecord {
  id: string;
  deleted: boolean;
  item?: Parameters<typeof decryptItemText>[0];
}

interface KatFixture {
  password: string;
  desktop: {
    bundle: {
      vaultId: string;
      vaultUserId: string;
      kdf: { salt: string; memoryBytes: number; ops: number };
      encryptedUserKey: Parameters<typeof unwrapUserKey>[0];
    };
    records: KatRecord[];
    plaintexts: Record<string, string>;
  };
}

async function fixture(): Promise<KatFixture> {
  return JSON.parse(await readFile(new URL('../../../../../../fixtures/crypto/vault-sync-v3-kat.json', import.meta.url), 'utf8')) as KatFixture;
}

describe('Desktop vault crypto public contract', () => {
  it('decrypts every non-deleted sync-v3 KAT record byte-for-byte', async() => {
    // risk: crypto/data integrity — the domain rebuild must read existing vaults exactly.
    const kat = await fixture();
    const { bundle, records, plaintexts } = kat.desktop;
    const derived = await deriveMasterKey(kat.password, bundle.kdf.salt, {
      memoryBytes: bundle.kdf.memoryBytes,
      operations: bundle.kdf.ops,
    });
    const userKey = await unwrapUserKey(bundle.encryptedUserKey, derived.key);
    try {
      for (const record of records.filter(candidate => !candidate.deleted)) {
        expect(record.item).toBeDefined();
        await expect(decryptItemText(record.item!, userKey, {
          itemId: record.id,
          ownerId: bundle.vaultUserId,
        })).resolves.toBe(plaintexts[record.id]);
      }
    } finally {
      derived.key.fill(0);
      userKey.fill(0);
    }
  }, 20_000);

  it('rejects a wrong password and tampered fixture ciphertext', async() => {
    // risk: crypto/authentication — corruption or the wrong key must never yield plaintext.
    const kat = await fixture();
    const { bundle, records } = kat.desktop;
    const wrong = await deriveMasterKey(`${kat.password}!`, bundle.kdf.salt, {
      memoryBytes: bundle.kdf.memoryBytes,
      operations: bundle.kdf.ops,
    });
    await expect(unwrapUserKey(bundle.encryptedUserKey, wrong.key)).rejects.toThrow();
    wrong.key.fill(0);

    const right = await deriveMasterKey(kat.password, bundle.kdf.salt, {
      memoryBytes: bundle.kdf.memoryBytes,
      operations: bundle.kdf.ops,
    });
    const userKey = await unwrapUserKey(bundle.encryptedUserKey, right.key);
    const record = records.find(candidate => !candidate.deleted && candidate.item)!;
    const tampered = structuredClone(record.item!);
    tampered.ciphertext.ciphertext = `${tampered.ciphertext.ciphertext.slice(0, -1)}A`;
    await expect(decryptItemText(tampered, userKey, {
      itemId: record.id,
      ownerId: bundle.vaultUserId,
    })).rejects.toThrow();
    right.key.fill(0);
    userKey.fill(0);
  }, 20_000);

  it('binds Files key bundles to purpose and collection context', async() => {
    // risk: tenant isolation — collection keys must not open in another context.
    const recipient = await generateX25519RecipientKeyPair();
    const context = { collectionId: 'collection-a', principalId: 'principal-a', keyVersion: 1, epoch: 1 };
    const material = { dataKey: new Uint8Array(32).fill(17), dedupKey: new Uint8Array(32).fill(29) };
    const envelope = await sealFilesKeyBundle(material, context, 'authority-custody', recipient.publicKey);
    await expect(openFilesKeyBundle(envelope, context, 'authority-custody', recipient.publicKey, recipient.privateKey))
      .resolves.toEqual(material);
    await expect(openFilesKeyBundle(envelope, { ...context, collectionId: 'collection-b' }, 'authority-custody', recipient.publicKey, recipient.privateKey))
      .rejects.toThrow('context mismatch');
    await expect(openFilesKeyBundle(envelope, context, 'device-recovery', recipient.publicKey, recipient.privateKey))
      .rejects.toThrow('context mismatch');
  });
});
