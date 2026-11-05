// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  createSyncEnvelope,
  EnvelopeError,
  loadSodium,
  type SyncBundle,
  type SyncHead,
  type SyncRecord,
} from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';

interface Fixture {
  password: string;
  desktop: {
    bundle: SyncBundle;
    records: SyncRecord[];
    head: SyncHead;
    plaintexts: Record<string, string>;
  };
}

async function fixture(): Promise<Fixture> {
  const url = new URL('../../../../../../fixtures/crypto/vault-sync-v3-kat.json', import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as Fixture;
}

async function envelope() {
  return createSyncEnvelope(await loadSodium());
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof EnvelopeError ? error.code : undefined;
  }
}

describe('domain-backed Desktop vault sync codec', () => {
  it('unlocks, verifies, and decrypts the sync-v3 KAT byte-for-byte through the new path', async() => {
    // risk: crypto/data integrity — adopting the shared domain must open every existing Desktop sync byte.
    const kat = await fixture();
    const codec = await envelope();
    const userKey = codec.unlockBundle(kat.desktop.bundle, kat.password);
    try {
      codec.verifyBundle(kat.desktop.bundle, userKey);
      for (const record of kat.desktop.records) {
        codec.verifyRecord(record, userKey, { vaultId: record.vaultId, scope: record.scope, id: record.id });
        if (!record.deleted && record.item) {
          expect(codec.decryptItem(record.item, userKey, kat.desktop.bundle.vaultUserId, record.id))
            .toBe(kat.desktop.plaintexts[record.id]);
        }
      }
      codec.verifyHead(kat.desktop.head, userKey, {
        vaultId: kat.desktop.head.vaultId,
        scope: kat.desktop.head.scope,
        records: kat.desktop.records,
      });
    } finally {
      userKey.fill(0);
    }
  }, 60_000);

  it('preserves strict malformed-input error codes at the domain boundary', async() => {
    // risk: crypto/input validation — malformed sync payloads must remain fail-closed with stable codes.
    const kat = await fixture();
    const codec = await envelope();
    expect(errorCode(() => codec.verifyBundle({ ...kat.desktop.bundle, surprise: true }, new Uint8Array(32))))
      .toBe('bundle_shape');
    expect(errorCode(() => codec.verifyRecord({ ...kat.desktop.records[0], mac: 'bad' }, new Uint8Array(32), {
      vaultId: kat.desktop.records[0].vaultId,
      scope: kat.desktop.records[0].scope,
    }))).toBe('record_shape');
    expect(errorCode(() => codec.verifyHead({ ...kat.desktop.head, seq: 0 }, new Uint8Array(32), {
      vaultId: kat.desktop.head.vaultId,
      scope: kat.desktop.head.scope,
      records: kat.desktop.records,
    }))).toBe('head_shape');
    expect(errorCode(() => codec.unlockBundle({
      ...kat.desktop.bundle,
      kdf: { ...kat.desktop.bundle.kdf, memoryBytes: 1 },
    }, kat.password))).toBe('kdf_bounds');
    expect(errorCode(() => codec.unlockRecovery(kat.desktop.bundle, 'synthetic-recovery-code'))).toBe('recovery_missing');
  });

  it('keeps UTF-16 code-unit ordering for mixed-case and non-ASCII record ids', async() => {
    // risk: sync convergence — locale-dependent ordering would produce a different signed head.
    const codec = await envelope();
    const records = [
      { id: 'ä', generation: 1, deleted: true, mac: 'm1' },
      { id: 'Z', generation: 1, deleted: true, mac: 'm2' },
      { id: 'a', generation: 1, deleted: true, mac: 'm3' },
      { id: 'É', generation: 1, deleted: true, mac: 'm4' },
    ];
    const utf16Rows = records
      .map(record => [record.id, record.generation, record.deleted, record.mac])
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    const expected = createHash('sha256').update(JSON.stringify(utf16Rows)).digest('base64url');
    expect(codec.stateHash([records[1], records[2], records[3], records[0]])).toBe(expected);
  });
});
