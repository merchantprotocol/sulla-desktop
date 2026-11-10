// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { NobleCryptoPrimitives } from '@sulla/domain';
import { DomainVaultSyncCodec } from '../../../../../../services/sulla-vault/src/browserEnvelope/DomainVaultSyncCodec';
import { SodiumCryptoPrimitives } from '../../../../../../services/sulla-vault/src/browserEnvelope/SodiumCryptoPrimitives';
import { loadSodium } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';
import { HeadChainLinkPolicy } from '../../../../../../services/sulla-vault/src/browserEnvelope/syncRunner';

const vaultId = '12345678-1234-1234-1234-123456789abc';

describe('vault sync head-chain gap verification', () => {
  it('pins the local predecessor MAC only for an unchanged or adjacent head', () => {
    // risk: crypto/data integrity — reject forged immediate links while allowing a valid remote head after skipped commits.
    const policy = new HeadChainLinkPolicy();
    expect(policy.expectedPreviousMac(333, 333, 'local')).toBe('local');
    expect(policy.expectedPreviousMac(334, 333, 'local')).toBe('local');
    expect(policy.expectedPreviousMac(336, 333, 'local')).toBeUndefined();
  });

  it('accepts a valid multi-commit head but rejects a bad adjacent link, rollback, and state mismatch', async() => {
    // risk: crypto/data integrity — allow legitimate skipped commits without weakening adjacent-chain, rollback, or full-state checks.
    const sodium = await loadSodium();
    const crypto = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());
    const codec = new DomainVaultSyncCodec(crypto, crypto);
    const key = new Uint8Array(32).fill(9);
    const records = [];
    const oldHeadMac = 'a'.repeat(43);

    try {
      const gapHead = codec.buildHead({ vaultId, scope: 'personal', seq: 336, records, prevHeadMac: 'b'.repeat(43) }, key);
      expect(() => codec.verifyHead(gapHead, key, { vaultId, scope: 'personal', records, minSeq: 333 })).not.toThrow();

      const adjacentHead = codec.buildHead({ vaultId, scope: 'personal', seq: 334, records, prevHeadMac: 'b'.repeat(43) }, key);
      expect(() => codec.verifyHead(adjacentHead, key, { vaultId, scope: 'personal', records, minSeq: 333, expectedPrevHeadMac: oldHeadMac })).toThrow();

      const rollbackHead = codec.buildHead({ vaultId, scope: 'personal', seq: 330, records, prevHeadMac: oldHeadMac }, key);
      expect(() => codec.verifyHead(rollbackHead, key, { vaultId, scope: 'personal', records, minSeq: 333 })).toThrow();

      const otherState = [codec.buildRecord({ vaultId, scope: 'personal', kind: 'item', id: '87654321-4321-4321-4321-cba987654321', generation: 1, deleted: true }, key)];
      const stateHead = codec.buildHead({ vaultId, scope: 'personal', seq: 336, records: otherState, prevHeadMac: 'b'.repeat(43) }, key);
      expect(() => codec.verifyHead(stateHead, key, { vaultId, scope: 'personal', records, minSeq: 333 })).toThrow();
    } finally {
      key.fill(0);
    }
  }, 20_000);
});
