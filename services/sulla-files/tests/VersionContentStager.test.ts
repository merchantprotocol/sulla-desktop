// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { chunkId, decryptAndVerifyChunk, encryptChunk } from '../src/crypto.js';
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
