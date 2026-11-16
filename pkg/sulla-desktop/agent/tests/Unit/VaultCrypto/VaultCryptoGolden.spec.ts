// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of @sulla/vault-crypto's public named exports, pinned BEFORE the package moved
// into classes (oop-e5/vaultcrypto). Every golden value below was produced by the pre-refactor
// procedural code from fixtures/crypto/vault-sync-v3-kat.json; existing vaults must still open.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import * as vc from '../../../../../../packages/vault-crypto/src/index';

interface KatFixture {
  password: string;
  desktop: {
    bundle: {
      vaultUserId:         string;
      publicKey:           string;
      kdf:                 { salt: string; memoryBytes: number; ops: number };
      encryptedUserKey:    vc.EncryptedEnvelope;
      encryptedPrivateKey: vc.EncryptedEnvelope;
    };
    records:    { id: string; deleted: boolean; item?: vc.EncryptedItem }[];
    plaintexts: Record<string, string>;
  };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let kat: KatFixture;
let masterKey: vc.DerivedMasterKey;
let userKey: Uint8Array;

beforeAll(async() => {
  kat = JSON.parse(await readFile(new URL('../../../../../../fixtures/crypto/vault-sync-v3-kat.json', import.meta.url), 'utf8')) as KatFixture;
  const { kdf } = kat.desktop.bundle;
  masterKey = await vc.deriveMasterKey(kat.password, kdf.salt, { memoryBytes: kdf.memoryBytes, operations: kdf.ops });
  userKey = await vc.unwrapUserKey(kat.desktop.bundle.encryptedUserKey, masterKey.key);
}, 20_000);

describe('vault-crypto key derivation (golden)', () => {
  it('derives the exact master key, auth hashes and user keys from the sync-v3 KAT', async() => {
    // risk: crypto/data integrity — a changed KDF or hash domain locks every user out of their vault.
    expect(sha256(masterKey.key)).toBe('ddae87387b70292c5399e72698fdc919fd5f4ef855996609795738751f2dd515');
    expect(masterKey.salt).toBe('Xp5muFbbph74ANZBtYjLOQ');
    expect(await vc.deriveAccountAuthHash(masterKey.key)).toBe('3danS0YxSBqwlR7yYb3hf_vxtexaEoXLjvRsjIRZokQ');
    expect(await vc.deriveLoginHash(masterKey.key)).toBe('rpPnp59dB10FAbhKapu74AJk2GVuTymMrUc9r_JcyLc');
    expect(sha256(userKey)).toBe('7ebb5088586a65d05f926a56c39e3ee8ce635a495efdeae2051f8dd2009f74d2');
    const privateKey = await vc.unwrapUserPrivateKey(kat.desktop.bundle.encryptedPrivateKey, userKey);
    expect(sha256(privateKey)).toBe('4cf41a63e498d9904948adcb201c275ea6d2c5fb05dbe3865ec1ede57675129d');
    expect(await vc.publicKeyFingerprint(kat.desktop.bundle.publicKey)).toBe('DduQDjJPIBw');
    // The unwrapped private key must still pair with the stored public key.
    const probe = new Uint8Array(32).fill(7);
    const sealed = await vc.wrapKeyToPublicKey(probe, kat.desktop.bundle.publicKey);
    expect(await vc.unwrapKeyFromPublicKey(sealed, kat.desktop.bundle.publicKey, privateKey)).toEqual(probe);
  });

  it('derives the exact org join hash and refuses empty inputs', async() => {
    // risk: auth — a different join hash refuses every existing org invite.
    expect(await vc.deriveOrgJoinHash('join-pass', 'org-1')).toBe('XQnntOUkHHRDk3a6cBODJKg5lG9aBDEwgsAFZ-1UD4E');
    await expect(vc.deriveOrgJoinHash('', 'org-1')).rejects.toThrow('Join password and organization id are required');
    await expect(vc.deriveMasterKey('', kat.desktop.bundle.kdf.salt)).rejects.toThrow('Master password cannot be empty');
    await expect(vc.deriveMasterKey('pw', 'AAEC')).rejects.toThrow('Argon2id salt must be 16 bytes');
    await expect(vc.deriveAccountAuthHash(new Uint8Array(31))).rejects.toThrow('Master key must be 32 bytes');
  });
});

describe('vault-crypto item encryption', () => {
  it('decrypts every stored sync-v3 KAT item byte-for-byte', async() => {
    // risk: data integrity — existing ciphertext must decrypt to the same plaintext.
    const live = kat.desktop.records.filter(record => !record.deleted && record.item);
    expect(live.length).toBeGreaterThan(0);
    for (const record of live) {
      await expect(vc.decryptItemText(record.item!, userKey, { itemId: record.id, ownerId: kat.desktop.bundle.vaultUserId }))
        .resolves.toBe(kat.desktop.plaintexts[record.id]);
    }
  });

  it('pins item associated data and refuses a context without ids', () => {
    // risk: data integrity — the AEAD context string is part of every stored ciphertext.
    expect(vc.itemAssociatedData('key', { itemId: 'i', ownerId: 'o' })).toBe('sulla:item:key:v1:["o","i"]');
    expect(vc.itemAssociatedData('ciphertext', { itemId: 'i', ownerId: 'o' })).toBe('sulla:item:ciphertext:v1:["o","i"]');
    expect(() => vc.itemAssociatedData('key', { itemId: '', ownerId: 'o' })).toThrow('Item context requires an item id and owner id');
  });

  it('round-trips an item, lets the named agent open it, and refuses another owner context', async() => {
    // risk: secret disclosure / tenant isolation — an item must only open in its own owner+item context.
    const agent = await vc.generateX25519RecipientKeyPair();
    const context = { itemId: 'item-1', ownerId: 'owner-1' };
    const item = await vc.encryptItem('{"name":"bank"}', userKey, context, agent.publicKey);
    expect(item.version).toBe(1);
    expect(item.encryptedItemKey.algorithm).toBe('xchacha20-poly1305');
    expect(item.agentWrappedItemKey?.algorithm).toBe('x25519-sealed-box');
    await expect(vc.decryptItemText(item, userKey, context)).resolves.toBe('{"name":"bank"}');
    await expect(vc.decryptItem(item, userKey, { ...context, ownerId: 'owner-2' })).rejects.toThrow();
    const itemKey = await vc.unwrapItemKeyForAgent(item.agentWrappedItemKey!, agent.publicKey, agent.privateKey);
    const plain = await vc.decryptWithKey(item.ciphertext, itemKey, vc.itemAssociatedData('ciphertext', context));
    expect(new TextDecoder().decode(plain)).toBe('{"name":"bank"}');
    expect((await vc.encryptItem(new Uint8Array([1]), userKey, context)).agentWrappedItemKey).toBeUndefined();
    await expect(vc.decryptItem({ ...item, version: 2 as 1 }, userKey, context)).rejects.toThrow('Unsupported item version');
  });

  it('round-trips user, collection and org keys and rejects wrong keys or envelopes', async() => {
    // risk: crypto — wrapped keys must only open with the right parent key and context.
    const { userKey: fresh, encryptedUserKey } = await vc.createUserKey(masterKey.key);
    expect(await vc.unwrapUserKey(encryptedUserKey, masterKey.key)).toEqual(fresh);
    await expect(vc.unwrapUserKey(encryptedUserKey, fresh)).rejects.toThrow();
    const pair = await vc.createUserKeyPair(fresh);
    expect(await vc.unwrapUserPrivateKey(pair.encryptedPrivateKey, fresh)).toEqual(pair.privateKey);
    const orgKey = await vc.generateKey();
    const collectionKey = await vc.generateKey();
    const wrapped = await vc.wrapCollectionKey(collectionKey, orgKey);
    expect(await vc.unwrapCollectionKey(wrapped, orgKey)).toEqual(collectionKey);
    // A collection key envelope is context-bound: it must not open as a user key.
    await expect(vc.unwrapUserKey(wrapped, orgKey)).rejects.toThrow();
    const member = await vc.wrapOrgKeyForMember(orgKey, pair.publicKey);
    expect(await vc.unwrapOrgKeyForMember(member, pair.publicKey, pair.privateKey)).toEqual(orgKey);
    await expect(vc.unwrapKeyFromPublicKey({ ...member, algorithm: 'x' as 'x25519-sealed-box' }, pair.publicKey, pair.privateKey))
      .rejects.toThrow('Unsupported public-key envelope');
    await expect(vc.decryptWithKey({ ...wrapped, version: 2 as 1 }, orgKey, 'sulla:collection-key:v1'))
      .rejects.toThrow('Unsupported encrypted envelope');
    await expect(vc.encryptWithKey(new Uint8Array(1), new Uint8Array(31), 'ctx')).rejects.toThrow('Encryption key must be 32 bytes');
    await expect(vc.wrapKeyToPublicKey(new Uint8Array(16), pair.publicKey)).rejects.toThrow('Wrapped key must be 32 bytes');
  });
});

describe('vault-crypto Files key bundles', () => {
  const context = { collectionId: 'c', principalId: 'p', keyVersion: 2, epoch: 3 };

  it('pins the bundle associated data and refuses invalid contexts', () => {
    // risk: data integrity — stored Files key bundles are bound to this exact string.
    expect(vc.filesKeyBundleAssociatedData('device-recovery', 'dedup', context))
      .toBe('sulla:files:key-bundle:device-recovery:dedup:v1:["p","c",2,3]');
    expect(() => vc.filesKeyBundleAssociatedData('authority-custody', 'data', { ...context, collectionId: '' }))
      .toThrow('Files key bundle requires collection and principal ids');
    expect(() => vc.filesKeyBundleAssociatedData('authority-custody', 'data', { ...context, keyVersion: 0 }))
      .toThrow('Files key bundle version must be a positive integer');
    expect(() => vc.filesKeyBundleAssociatedData('authority-custody', 'data', { ...context, epoch: 1.5 }))
      .toThrow('Files key bundle epoch must be a positive integer');
  });

  it('rewraps authority custody for one device only and rejects bad material', async() => {
    // risk: tenant isolation / key custody — only the target device may open its recovery bundle.
    const authority = await vc.generateX25519RecipientKeyPair();
    const device = await vc.generateX25519RecipientKeyPair();
    const material = { dataKey: new Uint8Array(32).fill(3), dedupKey: new Uint8Array(32).fill(5) };
    const custody = await vc.sealFilesKeyBundle(material, context, 'authority-custody', authority.publicKey);
    expect(custody).toMatchObject({ version: 1, algorithm: 'x25519+xchacha20-poly1305', purpose: 'authority-custody', context });
    const forDevice = await vc.rewrapFilesKeyBundleForDevice(custody, context, authority.publicKey, authority.privateKey, device.publicKey);
    expect(forDevice.purpose).toBe('device-recovery');
    expect(await vc.openFilesKeyBundle(forDevice, context, 'device-recovery', device.publicKey, device.privateKey)).toEqual(material);
    await expect(vc.openFilesKeyBundle(forDevice, context, 'device-recovery', authority.publicKey, authority.privateKey)).rejects.toThrow();
    await expect(vc.openFilesKeyBundle(forDevice, { ...context, epoch: 4 }, 'device-recovery', device.publicKey, device.privateKey))
      .rejects.toThrow('Files key bundle context mismatch');
    // A swapped data/dedup ciphertext fails AEAD rather than returning the wrong key.
    const swapped = { ...forDevice, dataKey: forDevice.dedupKey };
    await expect(vc.openFilesKeyBundle(swapped, context, 'device-recovery', device.publicKey, device.privateKey)).rejects.toThrow();
    await expect(vc.sealFilesKeyBundle({ ...material, dedupKey: new Uint8Array(16) }, context, 'authority-custody', authority.publicKey))
      .rejects.toThrow('Files collection keys must be 32 bytes');
  });
});
