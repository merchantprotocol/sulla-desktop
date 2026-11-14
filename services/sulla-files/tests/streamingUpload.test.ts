import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PlaintextChunkReader } from '../src/plaintextChunkReader.js';

const CHUNK_BYTES = 4 * 1024 * 1024;

describe('PlaintextChunkReader', () => {
  it('keeps its working buffer bounded while splitting oversized request frames', async () => {
    // risk: memory/OOM — a multi-chunk request frame must not be duplicated into
    // a pending whole-file Buffer while it is divided into persisted chunks.
    const sourceBytes = CHUNK_BYTES * 3 + 17;
    let peakWorkingBytes = 0;
    const frames = (async function * () {
      for (let offset = 0; offset < sourceBytes; offset += 64 * 1024) {
        yield Buffer.alloc(Math.min(64 * 1024, sourceBytes - offset), 0x5a);
      }
    })();
    const reader = new PlaintextChunkReader(Readable.from(frames), sourceBytes, sourceBytes, bytes => {
      peakWorkingBytes = Math.max(peakWorkingBytes, bytes);
    });
    const chunkLengths:number[] = [];
    let total = 0;
    for await (const chunk of reader.chunks()) {
      chunkLengths.push(chunk.length);
      total += chunk.length;
      expect(chunk.every(byte => byte === 0x5a)).toBe(true);
    }
    expect(chunkLengths).toEqual([CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 17]);
    expect(total).toBe(sourceBytes);
    expect(peakWorkingBytes).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it('rejects a body that exceeds its declared size', async () => {
    // risk: data integrity — a client cannot silently persist bytes beyond its declaration.
    const reader = new PlaintextChunkReader(Readable.from([Buffer.alloc(4), Buffer.alloc(2)]), 5, 10);
    await expect(async () => { for await (const _chunk of reader.chunks()) { /* drain */ } }).rejects.toThrow('Upload exceeded its declared size');
  });
});
