// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterization of the Files sync envelope v1 wire format (FILES-SYNC-DESIGN.md §3).
// The expected bytes were produced by the pre-OOP envelope.ts (main 6be9f975f) with fixed keys and
// nonces. Cloud and every other Desktop decrypt these exact bytes, so any change here is a break.
import { describe, expect, it } from 'vitest';
import {
  b64u, chunkId, escrowKey, FLAG_DEFLATE_RAW, generateTransportKeyPair, hex, openChunk, openCollectionInfo, openEscrow, openEscrowWithKey,
  openManifest, sealChunk, sealCollectionInfo, sealEscrow, sealManifest, sha256Hex, signHead, stateHash, subkey, transportUnwrap, transportWrap,
  unb64u, verifyHead, type ManifestPlain,
} from '../src/cloudSync/envelope.js';

const FIXTURE = {
  subkey: 'd8d094330e6f4e18457388be09967468b512a6ff0bba2639bfd9ef77f3edd85e',
  chunkId: '7374c478c7c4decbf72d0cc53ee40558dd425f82e00596cc9f8c87015b3438bd',
  sealChunk: '534643310000000003a0a1a2a3a4a5a6a7a8a9aaab4eeaffc1c26754faca4104eb0d69aa64d8d5a5a1d1a4752ad1f55ae96c9c91395b905c96d28cf851f5f1f5bb2b7d6b86a5e2',
  sealChunkDeflate: '534643310100000003a0a1a2a3a4a5a6a7a8a9aaab4eeaffc1c26754faca4104eb0d69aa64d8d5a5a1d1a4752ad1f55ae96c9c91395b90de68cc8779fb3b1a2b9cde2d93b91304',
  manifest: {
    format: 'sulla-files-sync-manifest',
    v: 1,
    alg: 'A256GCM',
    collectionId: '11111111-2222-4333-8444-555555555555',
    keyVersion: 3,
    fileId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
    versionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    nonce: 'oKGio6Slpqeoqaqr',
    ct: 'bKtrEyO1qcZU9QERP-tRfekMiFUQreGaugzFLp8VTtkALmcZCofMHMqL_TwuyFD-ObKGW7vmIyyuScsK1TZvL6GTu5BrKOPUZPZGQZeDPQVHzg9WZH-3kdYnf1XMrKrEdaT_XymlOoTOdL44hLzyIX8wGATnYeHRozHIUWqL0ble0prTEzgkvVFRG_K6a6pTCY3FMudc6jY8AL_B-AzF6zNndnaeKkW1RmyT5hJBDtIg94IipvuxRmqFhIyYll_O4nK4NVH2zZ40m6RwbcjeEaU1qPIhSREhYCyjMI4bHye7BL-Vqmn22v6Hv0TS447mqCk0uZ_vCmXZFW-SVWr0M5etb653SkeuUjWKYS0icTyZcCbA2dubMETHoRf9gbdq48DlSpCEwCT1KFcqmRFu3ic2'
  },
  info: {
    format: 'sulla-files-sync-collection-info',
    v: 1,
    alg: 'A256GCM',
    collectionId: '11111111-2222-4333-8444-555555555555',
    keyVersion: 3,
    nonce: 'oKGio6Slpqeoqaqr',
    ct: 'qJyF3OX57osYAO1MsRDhtmcbBnsi54qEqnXgpfX36X6b_ElfEslDb1w'
  },
  stateHash: '6eb723c96f4e2ba789c8c0295dbe2f70e66b2c93f8b12598c6f31505e2764333',
  emptyStateHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  head: {
    format: 'sulla-files-sync-head',
    v: 1,
    collectionId: '11111111-2222-4333-8444-555555555555',
    keyVersion: 3,
    seq: 7,
    stateHash: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    prevMac: '',
    mac: '07e94f62901368962052edf310121ecbea24466906265746d2c79c723f1c5760'
  },
  escrowKey: 'fd86f7362df373483804c6aa820dba76462afbcba36823b36b135680c044755d',
  escrow: {
    format: 'sulla-files-sync-escrow',
    v: 1,
    alg: 'A256GCM',
    kdf: 'HKDF-SHA256',
    vaultId: '01234567-89ab-4cde-8f01-23456789abcd',
    vaultEpoch: 2,
    collectionId: '11111111-2222-4333-8444-555555555555',
    keyVersion: 3,
    nonce: 'oKGio6Slpqeoqaqr',
    ct: 'pIadkjxpeoYIHx5Obsg34ut44G4qxsQ0VMxWO0TZA72_87bBfIb_IxP211AeG4oH'
  },
  b64u: '-vv8_Q',
  sha256Hex: '67bccc212ef92d9943a2798231cf2b0e5b03e371c7b8968ab8e438df7eb68698'
};

const root = new Uint8Array(32).map((_, i) => i + 1);
const userKey = new Uint8Array(32).map((_, i) => 200 - i);
const nonce = new Uint8Array(12).map((_, i) => 0xa0 + i);
const C = '11111111-2222-4333-8444-555555555555';
const F = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const V = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const VAULT = '01234567-89ab-4cde-8f01-23456789abcd';
const plain = new TextEncoder().encode('Sulla Files characterization chunk');
const manifest:ManifestPlain = {
  v: 1, path: 'Docs/a.txt', mime: 'text/plain', size: 34, mtime: '2026-11-16T00:00:00.000Z', sha256: 'ab'.repeat(32),
  chunks: [[FIXTURE.chunkId, 34]], deleted: false, parentVersionId: null,
};

describe('Files sync envelope v1 wire format', () => {
  it('derives the same subkeys, chunk ids, hashes and encodings', async() => {
    // risk: data accuracy, a changed derivation orphans every chunk already in Cloud.
    expect(hex(await subkey(root, 'manifest', C, 3, V))).toBe(FIXTURE.subkey);
    expect(await chunkId(root, C, 3, plain)).toBe(FIXTURE.chunkId);
    expect(await sha256Hex(plain)).toBe(FIXTURE.sha256Hex);
    expect(b64u(new Uint8Array([250, 251, 252, 253]))).toBe(FIXTURE.b64u);
    expect([...unb64u(FIXTURE.b64u)]).toEqual([250, 251, 252, 253]);
    expect(hex(await escrowKey(userKey, VAULT, 2))).toBe(FIXTURE.escrowKey);
  });

  it('seals chunks to the pinned bytes and opens them back', async() => {
    // risk: data accuracy, Cloud stores these bytes and other devices must open them.
    const wire = await sealChunk(root, C, 3, FIXTURE.chunkId, plain, 0, nonce);
    expect(hex(wire)).toBe(FIXTURE.sealChunk);
    expect(hex(await sealChunk(root, C, 3, FIXTURE.chunkId, plain, FLAG_DEFLATE_RAW, nonce))).toBe(FIXTURE.sealChunkDeflate);
    const opened = await openChunk(root, C, 3, FIXTURE.chunkId, Buffer.from(FIXTURE.sealChunk, 'hex'));
    expect(opened.flags).toBe(0);
    expect(new TextDecoder().decode(opened.body)).toBe('Sulla Files characterization chunk');
    await expect(openChunk(root, C, 4, FIXTURE.chunkId, wire)).rejects.toThrow('keyVersion mismatch');
    const tampered = Uint8Array.from(wire); tampered[tampered.length - 1] ^= 1;
    await expect(openChunk(root, C, 3, FIXTURE.chunkId, tampered)).rejects.toThrow();
  });

  it('seals manifests and collection info to the pinned envelopes and opens them back', async() => {
    // risk: data accuracy, a manifest another device cannot open loses that file version.
    expect(await sealManifest(root, C, 3, F, V, manifest, nonce)).toEqual(FIXTURE.manifest);
    expect(await openManifest(root, FIXTURE.manifest as never)).toEqual(manifest);
    await expect(openManifest(root, { ...FIXTURE.manifest, fileId: C } as never)).rejects.toThrow();
    expect(await sealCollectionInfo(root, C, 3, { v: 1, name: 'Projects' }, nonce)).toEqual(FIXTURE.info);
    expect(await openCollectionInfo(root, FIXTURE.info as never)).toEqual({ v: 1, name: 'Projects' });
    await expect(sealCollectionInfo(root, C, 3, { v: 1, name: '  ' }, nonce)).rejects.toThrow('bad collection info');
  });

  it('hashes state order-independently and signs heads with the pinned MAC', async() => {
    // risk: a different stateHash or MAC makes every device reject the Cloud head as tampered.
    expect(await stateHash([{ fileId: F, versionId: V, deleted: false }, { fileId: C, versionId: V, deleted: true }])).toBe(FIXTURE.stateHash);
    expect(await stateHash([{ fileId: C, versionId: V, deleted: true }, { fileId: F, versionId: V, deleted: false }])).toBe(FIXTURE.stateHash);
    expect(await stateHash([])).toBe(FIXTURE.emptyStateHash);
    const head = await signHead(root, { collectionId: C, keyVersion: 3, seq: 7, stateHash: 'cd'.repeat(32), prevMac: '' });
    expect(head).toEqual(FIXTURE.head);
    expect(await verifyHead(root, FIXTURE.head as never)).toBe(true);
    expect(await verifyHead(root, { ...FIXTURE.head, seq: 8 } as never)).toBe(false);
    await expect(signHead(root, { collectionId: C, keyVersion: 3, seq: -1, stateHash: '', prevMac: '' })).rejects.toThrow('bad seq');
  });

  it('seals escrow to the pinned envelope and recovers the root with the user or escrow key', async() => {
    // risk: data accuracy, escrow is the only way a new Desktop recovers a collection root.
    expect(await sealEscrow(userKey, VAULT, 2, C, 3, root, nonce)).toEqual(FIXTURE.escrow);
    expect([...await openEscrow(userKey, FIXTURE.escrow as never)]).toEqual([...root]);
    expect([...await openEscrowWithKey(await escrowKey(userKey, VAULT, 2), FIXTURE.escrow as never)]).toEqual([...root]);
    await expect(openEscrow(userKey, { ...FIXTURE.escrow, vaultEpoch: 3 } as never)).rejects.toThrow();
  });

  it('round-trips a key through the container transport and refuses another request id', async() => {
    // risk: the escrow key relay between Vault and Files must only open for the request that asked.
    const pair = await generateTransportKeyPair();
    const envelope = await transportWrap(root, pair.publicKey, F, VAULT, 2);
    expect(envelope).toMatchObject({ format: 'sulla-files-sync-transport', v: 1, alg: 'ECDH-P256+HKDF-SHA256+A256GCM' });
    expect([...await transportUnwrap(envelope, pair.privateKey, F, VAULT, 2)]).toEqual([...root]);
    await expect(transportUnwrap(envelope, pair.privateKey, V, VAULT, 2)).rejects.toThrow();
  });
});
