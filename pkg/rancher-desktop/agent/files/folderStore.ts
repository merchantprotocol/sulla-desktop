import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ChunkStore, StoredChunk } from './types';

export class FolderChunkStore implements ChunkStore {
  constructor(private readonly root: string) {}

  private path(collectionId: string, chunkId: string): string {
    if (!/^[a-f0-9]{64}$/.test(chunkId) || !/^[a-zA-Z0-9-]+$/.test(collectionId)) throw new Error('Invalid chunk address');
    return join(this.root, collectionId, chunkId.slice(0, 2), chunkId);
  }

  async has(collectionId: string, chunkId: string): Promise<boolean> {
    try { await stat(this.path(collectionId, chunkId)); return true } catch { return false }
  }

  async get(collectionId: string, chunkId: string): Promise<Uint8Array> {
    return readFile(this.path(collectionId, chunkId));
  }

  async put(collectionId: string, chunk: StoredChunk): Promise<void> {
    const target = this.path(collectionId, chunk.id);
    if (await this.has(collectionId, chunk.id)) return;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${ target }.tmp-${ process.pid }-${ Date.now() }`;
    await writeFile(temp, chunk.bytes, { mode: 0o600 });
    try { await rename(temp, target) } catch (error: any) {
      await rm(temp, { force: true });
      if (error?.code !== 'EEXIST') throw error;
    }
  }

  async delete(collectionId: string, chunkId: string): Promise<void> {
    await rm(this.path(collectionId, chunkId), { force: true });
  }
}
