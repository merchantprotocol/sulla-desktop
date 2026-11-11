// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { NobleCryptoPrimitives } from '@sulla/domain';
import { DomainVaultSyncCodec } from '../../../../../../services/sulla-vault/src/browserEnvelope/DomainVaultSyncCodec';
import { SodiumCryptoPrimitives } from '../../../../../../services/sulla-vault/src/browserEnvelope/SodiumCryptoPrimitives';
import { loadSodium, type SyncRecord } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';
import { CloudVaultSyncRunner, HeadChainLinkPolicy } from '../../../../../../services/sulla-vault/src/browserEnvelope/syncRunner';
import type { Database } from '../../../../../../services/sulla-vault/src/db';

const vaultId = '12345678-1234-1234-1234-123456789abc';

class SyncPullDatabase {
  readonly state = {
    owner_user_id: 'owner', vault_id: vaultId, epoch: 1, bundle_generation: 1,
    head_seq: 333, head_mac: 'a'.repeat(43), last_push_at: null, last_pull_at: null,
    last_error: null, bundle_sha: '',
  };

  async query(sql: string): Promise<{ rows: unknown[] }> {
    if (sql.includes('SELECT * FROM cloud_vault_sync_state')) return { rows: [this.state] };
    return { rows: [] };
  }

  async connect() {
    return {
      query: async(sql: string, values?: unknown[]) => {
        if (sql.includes('UPDATE cloud_vault_sync_state SET head_seq')) {
          this.state.head_seq = Number(values?.[1]);
          this.state.head_mac = String(values?.[2]);
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
  }
}

class GapCloudAuthority {
  constructor(private readonly head: unknown) {}

  async withUnlockedUserKey<T>(operation: (keys: { userId: string; userKey: Uint8Array; assertCurrent: () => void }) => Promise<T>): Promise<T> {
    const userKey = new Uint8Array(32).fill(9);
    try { return await operation({ userId: 'owner', userKey, assertCurrent: () => undefined }); }
    finally { userKey.fill(0); }
  }

  async sullaCloudRequest(input: { path: string }): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    if (input.path.includes('/bundle?')) return { status: 404, headers: {}, body: {} };
    return { status: 200, headers: {}, body: { head: this.head, records: [], nextCursor: '', syncPaused: false } };
  }
}

class NewerBundleDatabase {
  readonly state = {
    owner_user_id: '12345678-1234-1234-1234-123456789abd', vault_id: vaultId, epoch: 1, bundle_generation: 1,
    head_seq: 333, head_mac: 'a'.repeat(43), last_push_at: null, last_pull_at: null,
    last_error: null, bundle_sha: 'local-wrap-fingerprint',
  };
  readonly clientQueries: string[] = [];

  async query(sql: string): Promise<{ rows: unknown[] }> {
    if (sql.includes('SELECT * FROM cloud_vault_sync_state')) return { rows: [this.state] };
    return { rows: [] };
  }

  async connect() {
    return {
      query: async(sql: string, values?: unknown[]) => {
        this.clientQueries.push(sql);
        if (sql.includes('SET bundle_generation=$2')) this.state.bundle_generation = Number(values?.[1]);
        if (sql.includes('SET head_seq=$2')) {
          this.state.head_seq = Number(values?.[1]);
          this.state.head_mac = String(values?.[2]);
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
  }
}

class NewerBundleCloudAuthority extends GapCloudAuthority {
  constructor(head: unknown, private readonly bundle: unknown) { super(head); }

  async withUnlockedUserKey<T>(operation: (keys: { userId: string; userKey: Uint8Array; assertCurrent: () => void }) => Promise<T>): Promise<T> {
    const userKey = new Uint8Array(32).fill(9);
    try { return await operation({ userId: '12345678-1234-1234-1234-123456789abd', userKey, assertCurrent: () => undefined }); }
    finally { userKey.fill(0); }
  }

  async sullaCloudRequest(input: { path: string }): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    if (input.path.includes('/bundle?')) return { status: 200, headers: {}, body: { bundle: this.bundle } };
    return super.sullaCloudRequest(input);
  }
}

describe('vault sync head-chain gap verification', () => {
  it('pins the local predecessor MAC only for an unchanged or adjacent head', () => {
    // risk: crypto/data integrity — reject forged immediate links while allowing a valid remote head after skipped commits.
    const policy = new HeadChainLinkPolicy();
    expect(policy.expectedPreviousMac(333, 333, 'local')).toBe('local');
    expect(policy.expectedPreviousMac(334, 333, 'local')).toBe('local');
    expect(policy.expectedPreviousMac(336, 333, 'local')).toBeUndefined();
  });

  it('pulls a signed 336 head from local sequence 333 and advances the persisted head', async() => {
    // risk: crypto/data integrity — a valid multi-commit Cloud update must not wedge sync or advance without full-head verification.
    const sodium = await loadSodium();
    const crypto = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());
    const codec = new DomainVaultSyncCodec(crypto, crypto);
    const key = new Uint8Array(32).fill(9);
    const head = codec.buildHead({ vaultId, scope: 'personal', seq: 336, records: [], prevHeadMac: 'b'.repeat(43) }, key);
    const db = new SyncPullDatabase();
    const runner = new CloudVaultSyncRunner(
      db as unknown as Database,
      new GapCloudAuthority(head),
      { get: async() => codec } as never,
    );

    const result = await runner.pull('device');
    expect(result).toMatchObject({ applied: 0, headSeq: 336 });
    expect(db.state.head_seq).toBe(336);
    expect(db.state.head_mac).toBe(head.mac);
    key.fill(0);
  }, 20_000);

  it('records a newer Cloud bundle generation without changing the local user-key wrap', async() => {
    // risk: key custody — a remote password-wrapped copy must never replace Desktop's locally authoritative key wrapping.
    const sodium = await loadSodium();
    const crypto = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());
    const codec = new DomainVaultSyncCodec(crypto, crypto);
    const key = new Uint8Array(32).fill(9);
    const head = codec.buildHead({ vaultId, scope: 'personal', seq: 333, records: [], prevHeadMac: 'a'.repeat(43) }, key);
    const aead = { version: 1 as const, algorithm: 'xchacha20-poly1305' as const, nonce: 'A'.repeat(32), ciphertext: 'A'.repeat(22) };
    const bundle = codec.buildBundle({
      vaultId, vaultUserId: '12345678-1234-1234-1234-123456789abd', epoch: 1, bundleGeneration: 2,
      kdf: { alg: 'argon2id13', salt: 'A'.repeat(22), memoryBytes: 64 * 1024 * 1024, ops: 2 },
      encryptedUserKey: aead, publicKey: 'A'.repeat(43), encryptedPrivateKey: aead,
    }, key);
    const db = new NewerBundleDatabase();
    const runner = new CloudVaultSyncRunner(
      db as unknown as Database,
      new NewerBundleCloudAuthority(head, bundle),
      { get: async() => codec } as never,
    );

    await runner.pull('device');

    expect(db.state.bundle_generation).toBe(2);
    expect(db.state.bundle_sha).toBe('local-wrap-fingerprint');
    expect(db.clientQueries.some(sql => /UPDATE\s+users\b/i.test(sql))).toBe(false);
    expect(db.clientQueries.some(sql => sql.includes('SET bundle_generation=$2'))).toBe(true);
    key.fill(0);
  }, 20_000);

  it('accepts a valid multi-commit head but rejects a bad adjacent link, rollback, and state mismatch', async() => {
    // risk: crypto/data integrity — allow legitimate skipped commits without weakening adjacent-chain, rollback, or full-state checks.
    const sodium = await loadSodium();
    const crypto = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());
    const codec = new DomainVaultSyncCodec(crypto, crypto);
    const key = new Uint8Array(32).fill(9);
    const records: SyncRecord[] = [];
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
