import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { sendFileStream } from '../src/fileStream.js';

class CapturingResponse extends EventEmitter {
  readonly writes:Buffer[] = [];
  statusCode = 200;
  headers:Record<string,string|number> = {};
  ended = false;
  status(code:number) { this.statusCode = code; return this }
  setHeader(name:string, value:string|number) { this.headers[name] = value; return this }
  write(chunk:Buffer) { this.writes.push(chunk); return true }
  end() { this.ended = true; return this }
}

describe('sendFileStream', () => {
  it('writes content incrementally instead of sending a whole-file buffer', async () => {
    // risk: memory/OOM — downloads remain chunk-sized at the HTTP response boundary.
    const chunks = [Buffer.alloc(4, 1), Buffer.alloc(4, 2), Buffer.alloc(2, 3)];
    const response = new CapturingResponse();
    const content = { size:10, mime:'application/octet-stream', range:undefined, contentLength:10,
      body:(async function * () { for (const chunk of chunks) yield chunk })() } as any;
    await sendFileStream({method:'GET'} as any, response as any, content);
    expect(response.writes.map(chunk => chunk.length)).toEqual([4, 4, 2]);
    expect(Buffer.concat(response.writes)).toEqual(Buffer.concat(chunks));
    expect(response.ended).toBe(true);
  });
});
