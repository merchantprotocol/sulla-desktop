import type { Readable } from 'node:stream';

const CHUNK_BYTES = 4 * 1024 * 1024;

/** Splits a request stream into fixed-size plaintext chunks with one chunk of working storage. */
export class PlaintextChunkReader {
  constructor(private readonly body:Readable, private readonly expectedBytes?:number, private readonly maxBytes = Number.MAX_SAFE_INTEGER, private readonly observeBufferedBytes?:(bytes:number)=>void) {}

  async * chunks():AsyncGenerator<Buffer> {
    let pending = Buffer.allocUnsafe(CHUNK_BYTES);
    let used = 0;
    let total = 0;
    this.observeBufferedBytes?.(used);
    for await (const value of this.body) {
      const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += incoming.byteLength;
      if (total > this.maxBytes || (this.expectedBytes !== undefined && total > this.expectedBytes)) throw new Error('Upload exceeded its declared size');
      let offset = 0;
      while (offset < incoming.byteLength) {
        const copied = Math.min(CHUNK_BYTES - used, incoming.byteLength - offset);
        incoming.copy(pending, used, offset, offset + copied);
        used += copied;
        offset += copied;
        this.observeBufferedBytes?.(used);
        if (used === CHUNK_BYTES) {
          yield pending;
          pending = Buffer.allocUnsafe(CHUNK_BYTES);
          used = 0;
        }
      }
    }
    if (this.expectedBytes !== undefined && total !== this.expectedBytes) throw new Error('Upload did not match its declared size');
    if (used || total === 0) yield pending.subarray(0, used);
  }
}
