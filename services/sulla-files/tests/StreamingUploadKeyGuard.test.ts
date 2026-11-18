// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { StreamingUploadService } from '../src/streamingUpload.js';
import { defaultChunkCrypto } from '../src/crypto.js';
import { Store } from '../src/store.js';

describe('streamed upload active-key guard', () => {
  let root = '';
  let store:Store;
  beforeAll(async() => { root = await mkdtemp(join(tmpdir(), 'stream-upload-key-guard-')); store = new Store(root) });
  afterAll(async() => { if (root) await rm(root, { recursive:true, force:true }) });

  it('refuses stale keys before publishing or quarantining any blob', async() => {
    // risk: data integrity — streamed recovery must never replace a chunk using stale key material.
    const stale = { data:Buffer.alloc(32, 1), dedup:Buffer.alloc(32, 2) };
    const active = { data:Buffer.alloc(32, 3), dedup:Buffer.alloc(32, 4) };
    const query = vi.fn(async() => ({ rows:[] }));
    const service = new StreamingUploadService(undefined, undefined, undefined, undefined, undefined, () => ({ publishChunk:async(_upload:string, _id:string, publish:()=>Promise<void>) => publish() } as never));
    const config = {
      keyring:{ keys:async() => ({ data:Buffer.from(stale.data), dedup:Buffer.from(stale.dedup) }), keysFresh:async() => ({ data:Buffer.from(active.data), dedup:Buffer.from(active.dedup) }), invalidate:vi.fn() },
    } as unknown as Config;

    await expect(service.streamChunks(config, store as never, {
      uploadId:'upload', collectionId:'collection', expectedBytes:4, maxBytes:4,
      body:Readable.from([Buffer.from('data')]), intentDb:{ query } as never,
    })).rejects.toMatchObject({ status:503, code:'collection_key_unavailable' });
    const id = defaultChunkCrypto.chunkId(Buffer.from('data'), stale.dedup);
    expect(await store.has('collection', id)).toBe(false);
  });

  it('skips the fresh-key check for keyrings without keysFresh (test fakes)', async() => {
    // risk: data integrity — a keyring that lacks keysFresh must not trip the active-key guard.
    const key = { data:Buffer.alloc(32, 1), dedup:Buffer.alloc(32, 2) };
    const query = vi.fn(async() => ({ rows:[] }));
    const service = new StreamingUploadService(undefined, undefined, undefined, undefined, undefined, () => ({ publishChunk:async(_upload:string, _id:string, publish:()=>Promise<void>) => publish() } as never));
    const config = {
      keyring:{ keys:async() => ({ data:Buffer.from(key.data), dedup:Buffer.from(key.dedup) }), invalidate:vi.fn() },
    } as unknown as Config;

    const outcome = await service.streamChunks(config, store as never, {
      uploadId:'upload-no-fresh', collectionId:'collection', expectedBytes:4, maxBytes:4,
      body:Readable.from([Buffer.from('data')]), intentDb:{ query } as never,
    }).catch((error:unknown) => error);
    expect((outcome as { code?:string } | undefined)?.code).not.toBe('collection_key_unavailable');
  });
});
