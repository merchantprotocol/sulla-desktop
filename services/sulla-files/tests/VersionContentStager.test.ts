// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { chunkId, defaultChunkCrypto, decryptAndVerifyChunk, encryptChunk } from '../src/crypto.js';
import { ChunkKeyMismatchError, VERSION_CHUNK_BYTES, VersionContentStager } from '../src/VersionContentStager.js';

class MemoryChunkStore {
  readonly chunks = new Map<string, Uint8Array>();
  async storedSize(_collection:string, id:string) { return this.chunks.get(id)?.byteLength }
  async getBounded(_collection:string, id:string) { return this.chunks.get(id)! }
  async put(_collection:string, id:string, bytes:Uint8Array) { this.chunks.set(id, Buffer.from(bytes)) }
  readonly quarantined:Uint8Array[] = [];
  async quarantineAndReplace(_collection:string,id:string,bytes:Uint8Array) {
    this.quarantined.push(Buffer.from(this.chunks.get(id)!)); this.chunks.set(id,Buffer.from(bytes));
    return {oldBlobRef:'old-ref',newBlobRef:'new-ref'};
  }
}

describe('VersionContentStager dedupe verification', () => {
  it('quarantines an invalid same-id blob, audits it, and restores readable identical content', async() => {
    // risk: data integrity — preserve corrupt bytes while making identical content readable again.
    const collectionId = 'collection'; const data = Buffer.alloc(32, 1); const dedup = Buffer.alloc(32, 2);
    const store = new MemoryChunkStore(); const audits:any[]=[]; const stager = new VersionContentStager(
      { keys: async() => ({ data:Buffer.from(data), dedup:Buffer.from(dedup) }), keysFresh:async() => ({ data:Buffer.from(data), dedup:Buffer.from(dedup) }) }, store,
      { chunkId, encryptChunk, encryptChunkForCollection:(plain,key,id,active,collection) => defaultChunkCrypto.encryptChunkForCollection(plain,key,id,active,collection), decryptAndVerifyChunk },
      undefined, async event => { audits.push(event) },
    );
    const bytes = Buffer.from('deterministic plaintext');
    const id = chunkId(bytes, dedup);
    store.chunks.set(id, Buffer.from('not-valid-ciphertext'));
    await stager.stage(collectionId, bytes);
    expect(store.quarantined).toHaveLength(1);
    expect(Buffer.from(store.quarantined[0]).toString()).toBe('not-valid-ciphertext');
    expect(audits).toEqual([{collectionId,chunkId:id,oldBlobRef:'old-ref',newBlobRef:'new-ref',reason:'decrypt_verify_failed'}]);
    expect(await decryptAndVerifyChunk(store.chunks.get(id)!,data,dedup,id,bytes.length)).toEqual(bytes);
  });

  it('dedupes healthy chunks without rewriting them', async() => {
    // risk: data integrity — avoid replacing valid immutable ciphertext on an ordinary repeat upload.
    const collectionId='collection'; const data=Buffer.alloc(32,1); const dedup=Buffer.alloc(32,2); const store=new MemoryChunkStore();
    const stager=new VersionContentStager({keys:async()=>({data,dedup})},store,{chunkId,encryptChunk,decryptAndVerifyChunk});
    const bytes=Buffer.from('healthy'); const id=chunkId(bytes,dedup); store.chunks.set(id,await encryptChunk(bytes,data,id));
    const before=Buffer.from(store.chunks.get(id)!); await stager.stage(collectionId,bytes);
    expect(store.quarantined).toHaveLength(0); expect(store.chunks.get(id)).toEqual(before);
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
  it('does not quarantine or touch a corrupt blob when the stager key is stale', async() => {
    // risk: data integrity — a stale key must not replace a good current-key object or create a quarantine audit.
    const stale={data:Buffer.alloc(32,1),dedup:Buffer.alloc(32,2)}; const active={data:Buffer.alloc(32,3),dedup:Buffer.alloc(32,2)};
    const store=new MemoryChunkStore(); const bytes=Buffer.from('stale-cache regression'); const id=chunkId(bytes,stale.dedup);
    store.chunks.set(id,Buffer.from('preserve this blob')); const before=Buffer.from(store.chunks.get(id)!); let audits=0;
    const stager=new VersionContentStager({keys:async()=>({data:Buffer.from(stale.data),dedup:Buffer.from(stale.dedup)}),keysFresh:async()=>({data:Buffer.from(active.data),dedup:Buffer.from(active.dedup)})},store,
      {chunkId,encryptChunk,encryptChunkForCollection:(plain,key,chunkId,activeKey,collection) => defaultChunkCrypto.encryptChunkForCollection(plain,key,chunkId,activeKey,collection),decryptAndVerifyChunk},
      undefined,async()=>{audits++});
    await expect(stager.stage('collection',bytes)).rejects.toMatchObject({status:503,code:'collection_key_unavailable'});
    expect(store.quarantined).toHaveLength(0); expect(audits).toBe(0); expect(store.chunks.get(id)).toEqual(before);
  });
  it('stores a chunk when cached and freshly resolved collection keys match', async() => {
    // risk: data integrity — confirms correct collection key writes still pass the guard and are decryptable.
    const keys = { data:Buffer.alloc(32, 4), dedup:Buffer.alloc(32, 5) };
    const store = new MemoryChunkStore(); const stager = new VersionContentStager(
      { keys:async() => ({ data:Buffer.from(keys.data), dedup:Buffer.from(keys.dedup) }), keysFresh:async() => ({ data:Buffer.from(keys.data), dedup:Buffer.from(keys.dedup) }) }, store,
      { chunkId, encryptChunk, encryptChunkForCollection:(plain, key, id, current, collection) => defaultChunkCrypto.encryptChunkForCollection(plain, key, id, current, collection), decryptAndVerifyChunk },
    );
    await stager.stage('collection', bytes);
    expect(store.chunks.size).toBe(1);
    const id = chunkId(bytes, keys.dedup);
    await expect(decryptAndVerifyChunk(store.chunks.get(id)!, keys.data, keys.dedup, id, bytes.length)).resolves.toEqual(bytes);
  });
  it('resolves fresh keys once for a multi-chunk stage and uses the same proof for each encrypted chunk', async() => {
    // risk: data integrity — each chunk must be guarded without repeated key unwraps or a weaker per-chunk check.
    const keys = { data:Buffer.alloc(32, 0x31), dedup:Buffer.alloc(32, 0x32) };
    let freshCalls = 0;
    const store = new MemoryChunkStore();
    const stager = new VersionContentStager({
      keys:async() => ({ data:Buffer.from(keys.data), dedup:Buffer.from(keys.dedup) }),
      keysFresh:async() => { freshCalls += 1; return { data:Buffer.from(keys.data), dedup:Buffer.from(keys.dedup) } },
    }, store, {
      chunkId, encryptChunk,
      encryptChunkForCollection:(plain, key, id, current, collection) => defaultChunkCrypto.encryptChunkForCollection(plain, key, id, current, collection),
      decryptAndVerifyChunk,
    });
    const content = Buffer.alloc(VERSION_CHUNK_BYTES + 1, 0x42);
    const staged = await stager.stage('collection', content);
    expect(staged.chunks).toHaveLength(2);
    expect(store.chunks.size).toBe(2);
    expect(freshCalls).toBe(1);
  });
});


describe('chunk encryption key guard', () => {
  it('refuses an all-zero collection key with a retriable unavailable error', async() => {
    // risk: data integrity — a lock race must not persist ciphertext encrypted with zeroized key material.
    await expect(encryptChunk(Buffer.from('secret fixture'), Buffer.alloc(32), 'chunk-id'))
      .rejects.toMatchObject({ status:503, code:'collection_key_unavailable', retryAfter:1 });
  });
});


describe('VersionContentStager key-lifecycle race', () => {
  it('never stores a chunk when close zeroizes a cached key during store I/O', async() => {
    // risk: data integrity — service lock/restart during an awaited blob lookup cannot commit zero-key ciphertext.
    const cached = { data:Buffer.alloc(32, 0x41), dedup:Buffer.alloc(32, 0x42) };
    const active = { data:Buffer.from(cached.data), dedup:Buffer.from(cached.dedup) };
    let closed = false;
    const keyring = {
      keys:async() => cached,
      keysFresh:async() => ({ data:Buffer.from(active.data), dedup:Buffer.from(active.dedup) }),
      invalidate:() => undefined,
    };
    const store = new MemoryChunkStore();
    store.storedSize = async() => { cached.data.fill(0); cached.dedup.fill(0); closed = true; return undefined };
    const stager = new VersionContentStager(keyring, store,
      { chunkId, encryptChunk, encryptChunkForCollection:(plain, key, id, current, collection) => defaultChunkCrypto.encryptChunkForCollection(plain, key, id, current, collection), decryptAndVerifyChunk });
    await expect(stager.stage('collection', Buffer.from('race fixture')))
      .rejects.toMatchObject({ status:503, code:'collection_key_unavailable' });
    expect(closed).toBe(true); expect(store.chunks.size).toBe(0);
  });
});
