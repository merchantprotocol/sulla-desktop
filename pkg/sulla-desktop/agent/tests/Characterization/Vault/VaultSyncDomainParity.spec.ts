// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { NobleCryptoPrimitives } from '@sulla/domain';

import { DomainVaultSyncCodec } from '../../../../../../services/sulla-vault/src/browserEnvelope/DomainVaultSyncCodec';
import { SodiumCryptoPrimitives } from '../../../../../../services/sulla-vault/src/browserEnvelope/SodiumCryptoPrimitives';
import { loadSodium, type SyncBundle, type SyncRecord } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';

// The KAT fixture was produced by the Desktop envelope (before it moved to the domain codec)
// and by the Passwords worker in www-sulladesktop. The domain codec must reproduce it byte for byte.
interface KatSide {
  bundle: SyncBundle;
  records: SyncRecord[];
  head: { vaultId: string; scope: string; seq: number; prevHeadMac: string; stateHash: string; mac: string };
}
interface KatFixture { password: string; desktop: KatSide; browser: KatSide }

async function fixture(): Promise<KatFixture> {
  return JSON.parse(await readFile(new URL('../../../../../../fixtures/crypto/vault-sync-v3-kat.json', import.meta.url), 'utf8')) as KatFixture;
}

class FixedRandomSource { bytes(length: number): Uint8Array { return new Uint8Array(length).fill(7); } }

function bundleFields(bundle: SyncBundle) {
  const { format: _format, v: _version, mac: _mac, ...fields } = bundle;
  void _format; void _version; void _mac;
  return fields;
}

class DomainParityHarness {
  async codec(): Promise<DomainVaultSyncCodec> {
    const sodium = await loadSodium();
    return new DomainVaultSyncCodec(new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives()), new FixedRandomSource());
  }

  errorCodeOf(run: () => unknown): string | undefined {
    try { run(); } catch (error) { return (error as { code?: string }).code; }
    return undefined;
  }
}

describe('Domain vault-sync-v3 codec', () => {
  it('reproduces every KAT half byte-for-byte: bundle, record MAC, state hash and head', async() => {
    // risk: crypto/data integrity — drift would make sync records unreadable across Desktop, Cloud and Mobile.
    const kat = await fixture();
    const domain = await new DomainParityHarness().codec();

    for (const side of [kat.desktop, kat.browser]) {
      const userKey = domain.unlockBundle(side.bundle, kat.password);
      try {
        expect(domain.buildBundle(bundleFields(side.bundle), userKey)).toEqual(side.bundle);

        const records = side.records.map(record => {
          const { format: _format, v: _version, mac: _mac, ...fields } = record;
          void _format; void _version; void _mac;
          const rebuilt = domain.buildRecord(fields, userKey);
          expect(rebuilt).toEqual(record);
          expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(record));
          return rebuilt;
        });
        const head = domain.buildHead({ vaultId: side.head.vaultId, scope: side.head.scope, seq: side.head.seq, records, prevHeadMac: side.head.prevHeadMac }, userKey);
        expect(domain.stateHash(records)).toBe(side.head.stateHash);
        expect(head).toEqual(side.head);
      } finally {
        userKey.fill(0);
      }
    }
  }, 20_000);

  it('unlocks and verifies every KAT bundle through the domain codec', async() => {
    // risk: crypto/data integrity — production unlocks via DomainVaultSyncCodec; a wrong user key makes sync data unreadable.
    const kat = await fixture();
    const domain = await new DomainParityHarness().codec();

    for (const side of [kat.desktop, kat.browser]) {
      const userKey = domain.unlockBundle(side.bundle, kat.password);
      try {
        expect(() => domain.verifyBundle(side.bundle, userKey)).not.toThrow();
        expect(userKey).toHaveLength(32);
      } finally {
        userKey.fill(0);
      }
    }
  }, 20_000);

  it('rejects a wrong password with the domain wrong_password code', async() => {
    // risk: crypto/authentication — the escrow maps any unlock failure to wrong_password, so the unlock must throw.
    const kat = await fixture();
    const domain = await new DomainParityHarness().codec();

    for (const side of [kat.desktop, kat.browser]) {
      expect(new DomainParityHarness().errorCodeOf(() => domain.unlockBundle(side.bundle, 'wrong password'))).toBe('wrong_password');
    }
  }, 20_000);

  it('rejects a malformed record before any MAC check, with a record_shape code', async() => {
    // risk: crypto/data integrity — malformed sync input must fail closed with a stable caller-visible code.
    const key = new Uint8Array(32).fill(1);
    const domain = await new DomainParityHarness().codec();
    const malformed = { ...((await fixture()).desktop.records[0]), generation: 0 };

    expect(new DomainParityHarness().errorCodeOf(() => domain.verifyRecord(malformed, key, { vaultId: malformed.vaultId, scope: malformed.scope }))).toBe('record_shape');
    key.fill(0);
  });

  it('binds item ciphertext to its owner and item id (AAD), so a moved item cannot decrypt', async() => {
    // risk: crypto/authentication — a server that swaps an item under another id must not yield plaintext.
    const key = new Uint8Array(32).fill(1);
    const domain = await new DomainParityHarness().codec();
    const plaintext = JSON.stringify({ type: 'login', name: 'parity' });

    const item = domain.encryptItem(plaintext, key, 'owner', 'item-1');
    expect(domain.decryptItem(item, key, 'owner', 'item-1')).toBe(plaintext);
    expect(() => domain.decryptItem(item, key, 'owner', 'item-2')).toThrow();
    expect(() => domain.decryptItem(item, key, 'other-owner', 'item-1')).toThrow();
    key.fill(0);
  });
});
