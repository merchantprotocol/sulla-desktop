import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PlaintextChunkReader } from '../src/streamingUpload.js';

const CHUNK_BYTES = 4 * 1024 * 1024;

describe('PlaintextChunkReader', () => {
  it('keeps its working buffer bounded while splitting oversized request frames', async () => {
    // risk: memory/OOM — a multi-chunk request frame must not be duplicated into
    // a pending whole-file Buffer while it is divided into persisted chunks.
    const source = Buffer.alloc(CHUNK_BYTES * 3 + 17, 0x5a);
    let peakWorkingBytes = 0;
    const reader = new PlaintextChunkReader(Readable.from([source]), source.length, source.length, bytes => {
      peakWorkingBytes = Math.max(peakWorkingBytes, bytes);
    });
    const chunks:Buffer[] = [];
    for await (const chunk of reader.chunks()) chunks.push(chunk);
    expect(chunks.map(chunk => chunk.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 17]);
    expect(chunks.every(chunk => chunk.every(byte => byte === 0x5a))).toBe(true);
    expect(peakWorkingBytes).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it('rejects a body that exceeds its declared size', async () => {
    // risk: data integrity — a client cannot silently persist bytes beyond its declaration.
    const reader = new PlaintextChunkReader(Readable.from([Buffer.alloc(4), Buffer.alloc(2)]), 5, 10);
    await expect(async () => { for await (const _chunk of reader.chunks()) { /* drain */ } }).rejects.toThrow('Upload exceeded its declared size');
  });
});
