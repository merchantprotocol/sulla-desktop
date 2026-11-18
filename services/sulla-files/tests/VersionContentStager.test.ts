// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { chunkId, defaultChunkCrypto, decryptAndVerifyChunk, encryptChunk } from '../src/crypto.js';
import { ChunkKeyMismatchError, VersionContentStager } from '../src/VersionContentStager.js';

class MemoryChunkStore {
  readonly chunks = new Map<string, Uint8Array>();
  async storedSize(_collection:string, id:string) { return this.chunks.get(id)?.byteLength }
  async getBounded(_collection:string, id:string) { return this.chunks.get(id)! }
  async put(_collection:string, id:string, bytes:Uint8Array) { this.chunks.set(id, Buffer.from(bytes)) }
}

describe('VersionContentStager dedupe verification', () => {
  it('rejects a same-id blob whose AEAD/content identity does not verify under the current keys', async() => {
    // risk: data integrity — never create a version that silently reuses ciphertext unreadable by the collection key.
    const collectionId = 'collection'; const data = Buffer.alloc(32, 1); const dedup = Buffer.alloc(32, 2);
    const store = new MemoryChunkStore(); const stager = new VersionContentStager(
      { keys: async() => ({ data, dedup }) }, store,
      { chunkId, encryptChunk, decryptAndVerifyChunk },
    );
    const bytes = Buffer.from('deterministic plaintext');
    const id = chunkId(bytes, dedup);
    store.chunks.set(id, Buffer.from('not-valid-ciphertext'));
    await expect(stager.stage(collectionId, bytes)).rejects.toMatchObject({
      status: 422, code: 'chunk_key_mismatch', collectionId, chunkId: id,
    } satisfies Partial<ChunkKeyMismatchError>);
  });
});


describe('VersionContentStager active-key assertion', () => {
  const bytes = Buffer.from('stale-cache regression');
  it('refuses stale cached data key before any blob write', async() => {
    // risk: data integrity — an old profile/cache key must never persist ciphertext under the current collection identity.
    const stale = { data:Buffer.alloc(32, 1), dedup:Buffer.alloc(32, 2) };
    const active = { data:Buffer.alloc(32, 3), dedup:Buffer.alloc(32, 2) };
    const store = new MemoryChunkStore(); const stager = new VersionContentStager(
      { keys:async() => stale, keysFresh:async() => active, invalidate:() => undefined }, store,
      { chunkId, encryptChunk, encryptChunkForCollection:(plain, key, id, current, collection) => defaultChunkCrypto.encryptChunkForCollection(plain, key, id, current, collection), decryptAndVerifyChunk },
    );
    await expect(stager.stage('collection', bytes)).rejects.toMatchObject({ status:503, code:'collection_key_unavailable' });
    expect(store.chunks.size).toBe(0);
  });
  it('stores a chunk when cached and freshly resolved collection keys match', async() => {
    // risk: data integrity — confirms correct collection key writes still pass the guard and are decryptable.
    const keys = { data:Buffer.alloc(32, 4), dedup:Buffer.alloc(32, 5) };
    const store = new MemoryChunkStore(); const stager = new VersionContentStager(
      { keys:async() => keys, keysFresh:async() => ({ data:Buffer.from(keys.data), dedup:Buffer.from(keys.dedup) }) }, store,
      { chunkId, encryptChunk, encryptChunkForCollection:(plain, key, id, current, collection) => defaultChunkCrypto.encryptChunkForCollection(plain, key, id, current, collection), decryptAndVerifyChunk },
    );
    await stager.stage('collection', bytes);
    expect(store.chunks.size).toBe(1);
    const id = chunkId(bytes, keys.dedup);
    await expect(decryptAndVerifyChunk(store.chunks.get(id)!, keys.data, keys.dedup, id, bytes.length)).resolves.toEqual(bytes);
  });
});
