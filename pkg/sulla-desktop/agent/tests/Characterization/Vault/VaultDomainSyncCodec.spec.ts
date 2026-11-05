// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { CanonicalJson, KeyWrap, NobleCryptoPrimitives, VaultSyncCodec, WebCryptoRandomSource } from '@sulla/domain';
import { describe, expect, it } from 'vitest';

import { EnvelopeError } from '../../../../../../services/sulla-vault/src/browserEnvelope/VaultSyncContracts';
import type { VaultSyncEnvelope } from '../../../../../../services/sulla-vault/src/browserEnvelope/VaultSyncEnvelope';
import { VaultSyncRuntime } from '../../../../../../services/sulla-vault/src/browserEnvelope/VaultSyncRuntime';

// Passwords sync v3 through the @sulla/domain-backed vault container classes (VDK2).
// The error table was captured by running these exact inputs through main's
// procedural envelope.ts (pre-VDK2) and must not drift: code and message are
// both returned to clients by the cloud-sync routes.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Same length and alphabet, but the unused trailing bits are set, so it is not canonical base64url. */
function nonCanonical(value: string): string {
  const index = ALPHABET.indexOf(value[value.length - 1]);
  return value.slice(0, -1) + ALPHABET[(index & ~3) | 1];
}

function tampered(value: string): string {
  return (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
}

function outcome(action: () => unknown): string {
  try {
    action();
    return 'ok';
  } catch (error: any) {
    if (error instanceof EnvelopeError) return `${error.code} | ${error.message}`;
    return `!${error?.constructor?.name ?? typeof error}`;
  }
}

async function fixture(): Promise<any> {
  const url = new URL('../../../../../../fixtures/crypto/vault-sync-v3-kat.json', import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

async function envelope(): Promise<VaultSyncEnvelope> {
  return (await VaultSyncRuntime.create()).envelope;
}

const withoutMac = (value: any) => {
  const { format: _format, v: _v, mac: _mac, ...rest } = value;
  return rest;
};

/** Pinned against main's envelope.ts. Only bad_type's message changed: main named the JS type, the domain does not expose it. */
const MAIN_OUTCOMES: Array<[string, string]> = [
  ['bundle.null', 'bundle_shape | Vault bundle has unexpected fields'],
  ['bundle.extra', 'bundle_shape | Vault bundle has unexpected fields'],
  ['bundle.format', 'bundle_shape | Not a vault sync bundle'],
  ['bundle.v3', 'unsupported_version | Vault bundle version is newer than this app'],
  ['bundle.v1recovery', 'bundle_shape | Vault bundle has unexpected fields'],
  ['bundle.v2norecovery', 'bundle_shape | Recovery wrap is malformed'],
  ['bundle.v2badrecovery', 'bundle_shape | Recovery wrap is malformed'],
  ['bundle.vaultId', 'bundle_shape | Vault ids are malformed'],
  ['bundle.epoch0', 'bundle_shape | Vault bundle counters are malformed'],
  ['bundle.generationFloat', 'bundle_shape | Vault bundle counters are malformed'],
  ['bundle.publicKey', 'bundle_shape | Vault bundle key material is malformed'],
  ['bundle.macShort', 'bundle_shape | Vault bundle key material is malformed'],
  ['bundle.macTampered', 'bundle_mac | Vault bundle failed its integrity check'],
  ['bundle.macNonCanonical', 'bundle_mac | Vault bundle failed its integrity check'],
  ['bundle.badKey', 'bad_key | Key must be 32 bytes'],
  ['bundle.notBytesKey', 'bad_key | Key must be 32 bytes'],
  ['bundle.wrongKey', 'bundle_mac | Vault bundle failed its integrity check'],
  ['kdf.extra', 'kdf_shape | KDF parameters are malformed'],
  ['kdf.alg', 'kdf_alg | Unsupported KDF'],
  ['kdf.salt', 'kdf_salt | KDF salt must be 16 bytes'],
  ['kdf.memLow', 'kdf_bounds | KDF memory cost is outside the allowed range'],
  ['kdf.memHigh', 'kdf_bounds | KDF memory cost is outside the allowed range'],
  ['kdf.opsLow', 'kdf_bounds | KDF time cost is outside the allowed range'],
  ['kdf.opsHigh', 'kdf_bounds | KDF time cost is outside the allowed range'],
  ['unlock.wrongPassword', 'wrong_password | Wrong master password'],
  ['unlock.emptyPassword', 'password_required | Master password is required'],
  ['unlock.nonStringPassword', 'password_required | Master password is required'],
  ['unlock.macTampered', 'bundle_mac | Vault bundle failed its integrity check'],
  ['unlock.macNonCanonical', 'bundle_mac | Vault bundle failed its integrity check'],
  ['unlock.shape', 'bundle_shape | Vault bundle has unexpected fields'],
  ['unlock.kdfBounds', 'kdf_bounds | KDF memory cost is outside the allowed range'],
  ['unlock.saltNonCanonical', '!Error'],
  ['record.null', 'record_shape | Record is malformed'],
  ['record.v2', 'unsupported_version | Record version is newer than this app'],
  ['record.extra', 'record_shape | Record has unexpected fields'],
  ['record.format', 'record_shape | Not a vault sync record'],
  ['record.id', 'record_shape | Record ids are malformed'],
  ['record.scope', 'record_shape | Record ids are malformed'],
  ['record.kind', 'record_shape | Record kind is unknown'],
  ['record.generation0', 'record_shape | Record generation is malformed'],
  ['record.deletedString', 'record_shape | Record generation is malformed'],
  ['record.itemMalformed', 'record_shape | Record item envelope is malformed'],
  ['record.itemMissing', 'record_shape | Record has unexpected fields'],
  ['record.folderName', 'record_shape | Record folder name is malformed'],
  ['record.macShort', 'record_shape | Record MAC is malformed'],
  ['record.moved', 'record_moved | Record belongs to another vault or scope'],
  ['record.movedScope', 'record_moved | Record belongs to another vault or scope'],
  ['record.idMismatch', 'record_moved | Record id does not match'],
  ['record.movedBadKey', 'record_moved | Record belongs to another vault or scope'],
  ['record.badKey', 'bad_key | Key must be 32 bytes'],
  ['record.macTampered', 'record_mac | Record failed its integrity check'],
  ['record.macNonCanonical', 'record_mac | Record failed its integrity check'],
  ['record.generationReplay', 'record_mac | Record failed its integrity check'],
  ['record.tombstoneOk', 'ok'],
  ['head.extra', 'head_shape | Manifest head has unexpected fields'],
  ['head.format', 'head_shape | Not a manifest head'],
  ['head.v2', 'unsupported_version | Manifest head version is newer than this app'],
  ['head.seq0', 'head_shape | Manifest head is malformed'],
  ['head.stateHash', 'head_shape | Manifest head hashes are malformed'],
  ['head.prev', 'head_shape | Manifest head chain is malformed'],
  ['head.moved', 'head_moved | Manifest head belongs to another vault or scope'],
  ['head.movedBadKey', 'head_moved | Manifest head belongs to another vault or scope'],
  ['head.badKey', 'bad_key | Key must be 32 bytes'],
  ['head.macTampered', 'head_mac | Manifest head failed its integrity check'],
  ['head.macNonCanonical', 'head_mac | Manifest head failed its integrity check'],
  ['head.rollback', 'rollback | Sulla Cloud served an older copy than this browser has seen'],
  ['head.chain', 'head_chain | Manifest head does not extend the previously verified head'],
  ['head.chainSameSeq', 'ok'],
  ['head.omitted', 'state_mismatch | Records do not match the signed manifest'],
  ['head.duplicate', 'duplicate_record | Two records share one id'],
  ['head.ok', 'ok'],
  ['item.malformed', 'envelope_shape | Item envelope is malformed'],
  ['item.extra', 'envelope_shape | Item envelope is malformed'],
  ['item.wrongOwner', 'decrypt_failed | Decryption failed'],
  ['item.wrongItem', 'decrypt_failed | Decryption failed'],
  ['item.badKey', 'bad_key | Key must be 32 bytes'],
  ['item.wrongKey', 'decrypt_failed | Decryption failed'],
  ['build.bundleBadKey', 'bad_key | Key must be 32 bytes'],
  ['build.bundleFloat', 'non_integer | Canonical JSON only carries safe integers'],
  ['build.bundleShape', 'bundle_shape | Vault ids are malformed'],
  ['build.bundleFunction', 'bad_type | Canonical JSON cannot carry this value'],
  ['build.recordBadKey', 'bad_key | Key must be 32 bytes'],
  ['build.recordHuge', 'non_integer | Canonical JSON only carries safe integers'],
  ['build.recordShape', 'record_shape | Record ids are malformed'],
  ['build.headDuplicate', 'duplicate_record | Two records share one id'],
  ['build.headBadKey', 'bad_key | Key must be 32 bytes'],
  ['build.headSeq0', 'head_shape | Manifest head is malformed'],
];

describe('domain-backed Desktop vault sync (VaultSyncEnvelope)', () => {
  it('rebuilds and opens the vault-sync-v3 KAT byte-for-byte through the new path', async () => {
    // risk: crypto/data integrity — every byte Desktop uploads or verifies must stay identical to the shared KAT.
    const kat = await fixture();
    const sync = await envelope();
    for (const half of [kat.desktop, kat.browser]) {
      const userKey = sync.unlockBundle(half.bundle, kat.password);
      try {
        expect(sync.buildBundle(withoutMac(half.bundle), userKey)).toStrictEqual(half.bundle);
        for (const record of half.records) {
          expect(sync.buildRecord(withoutMac(record), userKey)).toStrictEqual(record);
          sync.verifyRecord(record, userKey, { vaultId: record.vaultId, scope: record.scope, id: record.id });
          if (!record.deleted)
            expect(sync.decryptItem(record.item, userKey, half.bundle.vaultUserId, record.id)).toBe(half.plaintexts[record.id]);
        }
        const { head } = half;
        expect(
          sync.buildHead(
            { vaultId: head.vaultId, scope: head.scope, seq: head.seq, records: half.records, prevHeadMac: head.prevHeadMac },
            userKey,
          ),
        ).toStrictEqual(head);
        sync.verifyHead(head, userKey, { vaultId: head.vaultId, scope: head.scope, records: [...half.records].reverse() });
      } finally {
        userKey.fill(0);
      }
    }
  }, 30_000);

  it('uses the same KAT the @sulla/domain package ships', async () => {
    // risk: crypto/data integrity — Desktop and the shared domain must be pinned to one fixture, not two drifting copies.
    const domainEntry = createRequire(import.meta.url).resolve('@sulla/domain');
    const shipped = path.join(path.dirname(domainEntry), '..', 'fixtures', 'crypto', 'sulla-desktop', 'vault-sync-v3-kat.json');
    expect(JSON.parse(await readFile(shipped, 'utf8'))).toStrictEqual(await fixture());
  });

  it("rejects malformed bundle, KDF, record, head and item input with main's exact codes and messages", async () => {
    // risk: crypto/input validation — malformed sync payloads must stay fail-closed with the established, observable codes.
    const outcomes = runCases(await envelope(), await fixture());
    expect(Object.entries(outcomes)).toStrictEqual(MAIN_OUTCOMES);
  }, 30_000);

  it('orders stateHash rows by UTF-16 code unit for mixed-case and non-ASCII ids', async () => {
    // risk: sync convergence — locale-dependent ordering would sign a different head than the browser computes.
    const kat = await fixture();
    const sync = await envelope();
    const rows = [
      { id: 'ä', generation: 1, deleted: true, mac: 'm1' },
      { id: 'Z', generation: 2, deleted: false, mac: 'm2' },
      { id: 'a', generation: 3, deleted: true, mac: 'm3' },
      { id: 'É', generation: 4, deleted: true, mac: 'm4' },
    ];
    const ordered = [rows[1], rows[2], rows[3], rows[0]].map((r) => [r.id, r.generation, r.deleted, r.mac]);
    const expected = createHash('sha256').update(JSON.stringify(ordered)).digest('base64url');
    const records = [rows[0], rows[3], rows[2], rows[1]] as any[];
    const userKey = sync.unlockBundle(kat.desktop.bundle, kat.password);
    try {
      const head = sync.buildHead({ vaultId: kat.desktop.head.vaultId, scope: 'personal', seq: 1, records }, userKey);
      expect(head.stateHash).toBe(expected);
      sync.verifyHead(head, userKey, { vaultId: head.vaultId, scope: 'personal', records: [...records].reverse() });
      // Domain v0.2.0 sorts with localeCompare: this is why VaultSyncSealer must stay until v0.2.1.
      const crypto = new NobleCryptoPrimitives();
      const codec = new VaultSyncCodec(crypto, new KeyWrap(crypto, WebCryptoRandomSource.fromGlobal()));
      expect(codec.stateHash(records)).not.toBe(expected);
    } finally {
      userKey.fill(0);
    }
    expect(new CanonicalJson().stringify(ordered)).toBe(JSON.stringify(ordered));
  }, 30_000);
});

function runCases(env: VaultSyncEnvelope, kat: any): Record<string, string> {
  const d = kat.desktop;
  const bundle = d.bundle;
  const [rec1, rec2, tomb] = d.records;
  const head = d.head;
  const out: Record<string, string> = {};
  const userKey: Uint8Array = env.unlockBundle(bundle, kat.password);
  const shortKey = new Uint8Array(16);
  const exp = (r: any) => ({ vaultId: r.vaultId, scope: r.scope, id: r.id });
  const headOpts = (records: any[], extra: object = {}) => ({ vaultId: head.vaultId, scope: head.scope, records, ...extra });
  const fieldsOf = (b: any) => {
    const { format: _f, v: _v, mac: _m, ...rest } = b;
    return rest;
  };
  const recordFieldsOf = (r: any) => {
    const { format: _f, v: _v, mac: _m, ...rest } = r;
    return rest;
  };

  // bundle shape
  out['bundle.null'] = outcome(() => env.verifyBundle(null, userKey));
  out['bundle.extra'] = outcome(() => env.verifyBundle({ ...bundle, surprise: 1 }, userKey));
  out['bundle.format'] = outcome(() => env.verifyBundle({ ...bundle, format: 'x' }, userKey));
  out['bundle.v3'] = outcome(() => env.verifyBundle({ ...bundle, v: 3 }, userKey));
  out['bundle.v1recovery'] = outcome(() =>
    env.verifyBundle({ ...bundle, recovery: { kdf: bundle.kdf, encryptedUserKey: bundle.encryptedUserKey } }, userKey),
  );
  out['bundle.v2norecovery'] = outcome(() => env.verifyBundle({ ...bundle, v: 2 }, userKey));
  out['bundle.v2badrecovery'] = outcome(() => env.verifyBundle({ ...bundle, v: 2, recovery: { kdf: bundle.kdf } }, userKey));
  out['bundle.vaultId'] = outcome(() => env.verifyBundle({ ...bundle, vaultId: 'nope' }, userKey));
  out['bundle.epoch0'] = outcome(() => env.verifyBundle({ ...bundle, epoch: 0 }, userKey));
  out['bundle.generationFloat'] = outcome(() => env.verifyBundle({ ...bundle, bundleGeneration: 1.5 }, userKey));
  out['bundle.publicKey'] = outcome(() => env.verifyBundle({ ...bundle, publicKey: 'short' }, userKey));
  out['bundle.macShort'] = outcome(() => env.verifyBundle({ ...bundle, mac: 'abc' }, userKey));
  out['bundle.macTampered'] = outcome(() => env.verifyBundle({ ...bundle, mac: tampered(bundle.mac) }, userKey));
  out['bundle.macNonCanonical'] = outcome(() => env.verifyBundle({ ...bundle, mac: nonCanonical(bundle.mac) }, userKey));
  out['bundle.badKey'] = outcome(() => env.verifyBundle(bundle, shortKey));
  out['bundle.notBytesKey'] = outcome(() => env.verifyBundle(bundle, 'key' as unknown as Uint8Array));
  out['bundle.wrongKey'] = outcome(() => env.verifyBundle(bundle, new Uint8Array(32)));
  // kdf
  out['kdf.extra'] = outcome(() => env.verifyBundle({ ...bundle, kdf: { ...bundle.kdf, x: 1 } }, userKey));
  out['kdf.alg'] = outcome(() => env.verifyBundle({ ...bundle, kdf: { ...bundle.kdf, alg: 'scrypt' } }, userKey));
  out['kdf.salt'] = outcome(() => env.verifyBundle({ ...bundle, kdf: { ...bundle.kdf, salt: 'abc' } }, userKey));
  out['kdf.memLow'] = outcome(() => env.verifyBundle({ ...bundle, kdf: { ...bundle.kdf, memoryBytes: 1 } }, userKey));
  out['kdf.memHigh'] = outcome(() => env.verifyBundle({ ...bundle, kdf: { ...bundle.kdf, memoryBytes: 2 ** 31 } }, userKey));
  out['kdf.opsLow'] = outcome(() => env.verifyBundle({ ...bundle, kdf: { ...bundle.kdf, ops: 1 } }, userKey));
  out['kdf.opsHigh'] = outcome(() => env.verifyBundle({ ...bundle, kdf: { ...bundle.kdf, ops: 11 } }, userKey));
  // unlock
  out['unlock.wrongPassword'] = outcome(() => env.unlockBundle(bundle, 'not the password'));
  out['unlock.emptyPassword'] = outcome(() => env.unlockBundle(bundle, ''));
  out['unlock.nonStringPassword'] = outcome(() => env.unlockBundle(bundle, 42 as unknown as string));
  out['unlock.macTampered'] = outcome(() => env.unlockBundle({ ...bundle, mac: tampered(bundle.mac) }, kat.password));
  out['unlock.macNonCanonical'] = outcome(() => env.unlockBundle({ ...bundle, mac: nonCanonical(bundle.mac) }, kat.password));
  out['unlock.shape'] = outcome(() => env.unlockBundle({ ...bundle, extra: 1 }, kat.password));
  out['unlock.kdfBounds'] = outcome(() => env.unlockBundle({ ...bundle, kdf: { ...bundle.kdf, memoryBytes: 1 } }, kat.password));
  out['unlock.saltNonCanonical'] = outcome(() =>
    env.unlockBundle({ ...bundle, kdf: { ...bundle.kdf, salt: nonCanonical(bundle.kdf.salt) } }, kat.password),
  );
  // record shape + verify
  out['record.null'] = outcome(() => env.verifyRecord(null, userKey, exp(rec1)));
  out['record.v2'] = outcome(() => env.verifyRecord({ ...rec1, v: 2 }, userKey, exp(rec1)));
  out['record.extra'] = outcome(() => env.verifyRecord({ ...rec1, extra: 1 }, userKey, exp(rec1)));
  out['record.format'] = outcome(() => env.verifyRecord({ ...rec1, format: 'x' }, userKey, exp(rec1)));
  out['record.id'] = outcome(() => env.verifyRecord({ ...rec1, id: 'x' }, userKey, exp(rec1)));
  out['record.scope'] = outcome(() => env.verifyRecord({ ...rec1, scope: 'team' }, userKey, exp(rec1)));
  out['record.kind'] = outcome(() => env.verifyRecord({ ...tomb, kind: 'note' }, userKey, exp(tomb)));
  out['record.generation0'] = outcome(() => env.verifyRecord({ ...rec1, generation: 0 }, userKey, exp(rec1)));
  out['record.deletedString'] = outcome(() => env.verifyRecord({ ...tomb, deleted: 'yes' }, userKey, exp(tomb)));
  out['record.itemMalformed'] = outcome(() => env.verifyRecord({ ...rec1, item: { version: 1 } }, userKey, exp(rec1)));
  out['record.itemMissing'] = outcome(() => env.verifyRecord(recordWithout(rec1, 'item'), userKey, exp(rec1)));
  out['record.folderName'] = outcome(() =>
    env.verifyRecord({ ...recordWithout(rec1, 'item'), kind: 'folder', encryptedName: { version: 1 } }, userKey, exp(rec1)),
  );
  out['record.macShort'] = outcome(() => env.verifyRecord({ ...rec1, mac: 'abc' }, userKey, exp(rec1)));
  out['record.moved'] = outcome(() => env.verifyRecord(rec1, userKey, { ...exp(rec1), vaultId: rec2.id }));
  out['record.movedScope'] = outcome(() => env.verifyRecord(rec1, userKey, { ...exp(rec1), scope: rec2.id }));
  out['record.idMismatch'] = outcome(() => env.verifyRecord(rec1, userKey, exp(rec2)));
  out['record.movedBadKey'] = outcome(() => env.verifyRecord(rec1, shortKey, { ...exp(rec1), vaultId: rec2.id }));
  out['record.badKey'] = outcome(() => env.verifyRecord(rec1, shortKey, exp(rec1)));
  out['record.macTampered'] = outcome(() => env.verifyRecord({ ...rec1, mac: tampered(rec1.mac) }, userKey, exp(rec1)));
  out['record.macNonCanonical'] = outcome(() => env.verifyRecord({ ...rec1, mac: nonCanonical(rec1.mac) }, userKey, exp(rec1)));
  out['record.generationReplay'] = outcome(() => env.verifyRecord({ ...rec2, generation: 1 }, userKey, exp(rec2)));
  out['record.tombstoneOk'] = outcome(() => env.verifyRecord(tomb, userKey, exp(tomb)));
  // head
  out['head.extra'] = outcome(() => env.verifyHead({ ...head, extra: 1 }, userKey, headOpts(d.records)));
  out['head.format'] = outcome(() => env.verifyHead({ ...head, format: 'x' }, userKey, headOpts(d.records)));
  out['head.v2'] = outcome(() => env.verifyHead({ ...head, v: 2 }, userKey, headOpts(d.records)));
  out['head.seq0'] = outcome(() => env.verifyHead({ ...head, seq: 0 }, userKey, headOpts(d.records)));
  out['head.stateHash'] = outcome(() => env.verifyHead({ ...head, stateHash: 'abc' }, userKey, headOpts(d.records)));
  out['head.prev'] = outcome(() => env.verifyHead({ ...head, prevHeadMac: 'abc' }, userKey, headOpts(d.records)));
  out['head.moved'] = outcome(() => env.verifyHead(head, userKey, { ...headOpts(d.records), scope: rec1.id }));
  out['head.movedBadKey'] = outcome(() => env.verifyHead(head, shortKey, { ...headOpts(d.records), vaultId: rec1.id }));
  out['head.badKey'] = outcome(() => env.verifyHead(head, shortKey, headOpts(d.records)));
  out['head.macTampered'] = outcome(() => env.verifyHead({ ...head, mac: tampered(head.mac) }, userKey, headOpts(d.records)));
  out['head.macNonCanonical'] = outcome(() => env.verifyHead({ ...head, mac: nonCanonical(head.mac) }, userKey, headOpts(d.records)));
  out['head.rollback'] = outcome(() => env.verifyHead(head, userKey, headOpts(d.records, { minSeq: 5 })));
  out['head.chain'] = outcome(() => env.verifyHead(head, userKey, headOpts(d.records, { expectedPrevHeadMac: head.mac })));
  out['head.chainSameSeq'] = outcome(() =>
    env.verifyHead(head, userKey, headOpts(d.records, { minSeq: 4, expectedPrevHeadMac: head.mac })),
  );
  out['head.omitted'] = outcome(() => env.verifyHead(head, userKey, headOpts([rec1, rec2])));
  out['head.duplicate'] = outcome(() => env.verifyHead(head, userKey, headOpts([rec1, rec2, tomb, rec1])));
  out['head.ok'] = outcome(() => env.verifyHead(head, userKey, headOpts([tomb, rec2, rec1])));
  // item
  out['item.malformed'] = outcome(() => env.decryptItem({ version: 1 }, userKey, bundle.vaultUserId, rec1.id));
  out['item.extra'] = outcome(() => env.decryptItem({ ...rec1.item, extra: 1 }, userKey, bundle.vaultUserId, rec1.id));
  out['item.wrongOwner'] = outcome(() => env.decryptItem(rec1.item, userKey, rec1.id, rec1.id));
  out['item.wrongItem'] = outcome(() => env.decryptItem(rec1.item, userKey, bundle.vaultUserId, rec2.id));
  out['item.badKey'] = outcome(() => env.decryptItem(rec1.item, shortKey, bundle.vaultUserId, rec1.id));
  out['item.wrongKey'] = outcome(() => env.decryptItem(rec1.item, new Uint8Array(32), bundle.vaultUserId, rec1.id));
  // build
  out['build.bundleBadKey'] = outcome(() => env.buildBundle(fieldsOf(bundle), shortKey));
  out['build.bundleFloat'] = outcome(() => env.buildBundle({ ...fieldsOf(bundle), epoch: 1.5 }, userKey));
  out['build.bundleShape'] = outcome(() => env.buildBundle({ ...fieldsOf(bundle), vaultId: 'x' }, userKey));
  out['build.bundleFunction'] = outcome(() => env.buildBundle({ ...fieldsOf(bundle), publicKey: (() => 1) as unknown as string }, userKey));
  out['build.recordBadKey'] = outcome(() => env.buildRecord(recordFieldsOf(rec1), shortKey));
  out['build.recordHuge'] = outcome(() => env.buildRecord({ ...recordFieldsOf(rec1), generation: 2 ** 60 }, userKey));
  out['build.recordShape'] = outcome(() => env.buildRecord({ ...recordFieldsOf(rec1), id: 'x' }, userKey));
  out['build.headDuplicate'] = outcome(() =>
    env.buildHead({ vaultId: head.vaultId, scope: head.scope, seq: 5, records: [rec1, rec1] }, userKey),
  );
  out['build.headBadKey'] = outcome(() =>
    env.buildHead({ vaultId: head.vaultId, scope: head.scope, seq: 5, records: d.records }, shortKey),
  );
  out['build.headSeq0'] = outcome(() => env.buildHead({ vaultId: head.vaultId, scope: head.scope, seq: 0, records: d.records }, userKey));
  userKey.fill(0);
  return out;
}

function recordWithout(record: any, key: string): any {
  const copy = { ...record };
  delete copy[key];
  return copy;
}
