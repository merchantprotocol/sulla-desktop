// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { NobleCryptoPrimitives } from '@sulla/domain';

import { DomainVaultSyncCodec } from '../../../../../../services/sulla-vault/src/browserEnvelope/DomainVaultSyncCodec';
import { SodiumCryptoPrimitives } from '../../../../../../services/sulla-vault/src/browserEnvelope/SodiumCryptoPrimitives';
import { checkRecordShape, createSyncEnvelope, loadSodium, type SyncBundle, type SyncRecord } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';

interface KatSide {
  bundle: SyncBundle;
  records: SyncRecord[];
  head: { vaultId: string; scope: string; seq: number; prevHeadMac: string; stateHash: string; mac: string };
}
interface KatFixture { desktop: KatSide; browser: KatSide }

async function fixture(): Promise<KatFixture> {
  return JSON.parse(await readFile(new URL('../../../../../../fixtures/crypto/vault-sync-v3-kat.json', import.meta.url), 'utf8')) as KatFixture;
}

class FixedRandomSource { bytes(length: number): Uint8Array { return new Uint8Array(length).fill(7); } }

function bundleFields(bundle: SyncBundle) {
  const { format: _format, v: _version, mac: _mac, ...fields } = bundle;
  void _format; void _version; void _mac;
  return fields;
}

describe('Domain vault-sync-v3 codec parity', () => {
  it('matches Desktop codec output for every KAT half: record bytes, MAC, state hash and head', async() => {
    // risk: crypto/data integrity — drift would make sync records unreadable across Desktop and Mobile.
    const kat = await fixture();
    const sodium = await loadSodium();
    const old = createSyncEnvelope(sodium);
    const crypto = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());

    for (const side of [kat.desktop, kat.browser]) {
      const userKey = old.unlockBundle(side.bundle, 'correct horse battery staple · sync v3');
      try {
        const domain = new DomainVaultSyncCodec(crypto, new FixedRandomSource());
        const oldBundle = old.buildBundle(bundleFields(side.bundle), userKey);
        const domainBundle = domain.buildBundle(bundleFields(side.bundle), userKey);
        expect(domainBundle).toEqual(oldBundle);

        const records = side.records.map(record => {
          const { format: _format, v: _version, mac: _mac, ...fields } = record;
          void _format; void _version; void _mac;
          const oldRecord = old.buildRecord(fields, userKey);
          const domainRecord = domain.buildRecord(fields, userKey);
          expect(domainRecord).toEqual(oldRecord);
          expect(JSON.stringify(domainRecord)).toBe(JSON.stringify(oldRecord));
          return oldRecord;
        });
        expect(domain.stateHash(records)).toBe(old.stateHash(records));
        const oldHead = old.buildHead({ vaultId: side.head.vaultId, scope: side.head.scope, seq: side.head.seq, records, prevHeadMac: side.head.prevHeadMac }, userKey);
        const domainHead = domain.buildHead({ vaultId: side.head.vaultId, scope: side.head.scope, seq: side.head.seq, records, prevHeadMac: side.head.prevHeadMac }, userKey);
        expect(domainHead).toEqual(oldHead);
        expect(domainHead.stateHash).toBe(side.head.stateHash);
        expect(domainHead.mac).toBe(side.head.mac);
      } finally {
        userKey.fill(0);
      }
    }
  }, 20_000);

  it('unlocks every KAT bundle with the domain codec to the same user key as the old envelope', async() => {
    // risk: crypto/data integrity — production unlocks via DomainVaultSyncCodec; a different user key makes sync data unreadable.
    const kat = await fixture();
    const sodium = await loadSodium();
    const old = createSyncEnvelope(sodium);
    const domain = new DomainVaultSyncCodec(new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives()), new FixedRandomSource());
    const password = 'correct horse battery staple · sync v3';

    for (const side of [kat.desktop, kat.browser]) {
      const oldKey = old.unlockBundle(side.bundle, password);
      const domainKey = domain.unlockBundle(side.bundle, password);
      try {
        expect(Buffer.from(domainKey).toString('hex')).toBe(Buffer.from(oldKey).toString('hex'));
      } finally {
        oldKey.fill(0);
        domainKey.fill(0);
      }
    }
  }, 20_000);

  it('rejects a wrong password on both the old and the domain unlock paths', async() => {
    // risk: crypto/authentication — the escrow maps any unlock throw to wrong_password, so both paths must throw.
    const kat = await fixture();
    const sodium = await loadSodium();
    const old = createSyncEnvelope(sodium);
    const domain = new DomainVaultSyncCodec(new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives()), new FixedRandomSource());

    for (const side of [kat.desktop, kat.browser]) {
      let oldCode: string | undefined;
      let domainThrew = false;
      try { old.unlockBundle(side.bundle, 'wrong password'); } catch (error) { oldCode = (error as { code?: string }).code; }
      try { domain.unlockBundle(side.bundle, 'wrong password'); } catch { domainThrew = true; }
      expect(oldCode).toBe('wrong_password');
      expect(domainThrew).toBe(true);
    }
  });

  it('preserves the old malformed-record error code', async() => {
    // risk: crypto/data integrity — malformed sync input must fail closed with a stable caller-visible code.
    const sodium = await loadSodium();
    const key = new Uint8Array(32).fill(1);
    const domain = new DomainVaultSyncCodec(new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives()), new FixedRandomSource());
    const malformed = { ...((await fixture()).desktop.records[0]), generation: 0 };
    const errorCode = (run: () => void): string => {
      try { run(); } catch (error) { return (error as { code: string }).code; }
      throw new Error('expected malformed record to be rejected');
    };
    expect(errorCode(() => checkRecordShape(malformed))).toBe(errorCode(() => domain.verifyRecord(malformed, key, { vaultId: malformed.vaultId, scope: malformed.scope })));
    key.fill(0);
  });

  it('matches item and folder AAD bytes used by the existing envelope', async() => {
    // risk: crypto/authentication — mismatched AAD prevents legitimate item and folder decryption.
    const sodium = await loadSodium();
    const key = new Uint8Array(32).fill(1);
    const domain = new DomainVaultSyncCodec(new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives()), new FixedRandomSource());
    const old = createSyncEnvelope(sodium);
    const originalRandom = sodium.randombytes_buf;
    sodium.randombytes_buf = (length: number) => new Uint8Array(length).fill(7);
    try {
      const plaintext = JSON.stringify({ type: 'login', name: 'parity' });
      expect(domain.encryptItem(plaintext, key, 'owner', 'item-1'))
        .toEqual(old.encryptItem(plaintext, key, 'owner', 'item-1'));
    } finally {
      sodium.randombytes_buf = originalRandom;
    }
    expect(domain.itemAad('key', 'owner', 'item-1')).toBe('sulla:item:key:v1:["owner","item-1"]');
    expect(domain.itemAad('ciphertext', 'owner', 'item-1')).toBe('sulla:item:ciphertext:v1:["owner","item-1"]');
    expect(domain.folderAad('owner', 'folder-1')).toBe('sulla:folder-name:v1:["owner","folder-1"]');
    key.fill(0);
  });
});
