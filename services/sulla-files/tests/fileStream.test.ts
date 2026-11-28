// SPDX-License-Identifier: GPL-2.0-or-later
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FileStreamResponder, sendFileStream } from '../src/sendFileStream.js';

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

  it('answers a range request with 206, the Content-Range header and only the requested bytes', async () => {
    // risk: data accuracy — media seeking gets the wrong bytes or a 200 the player rejects.
    const response = new CapturingResponse();
    const body = Buffer.from('3456');
    const content = { size:10, mime:'video/mp4', range:{ start:3, end:6 }, contentLength:4, body:(async function * () { yield body })() } as any;
    await new FileStreamResponder().send({method:'GET'} as any, response as any, content, 'attachment; filename="a.mp4"');
    expect(response.statusCode).toBe(206);
    expect(response.headers['Content-Range']).toBe('bytes 3-6/10');
    expect(response.headers['Content-Length']).toBe(4);
    expect(response.headers['Content-Disposition']).toBe('attachment; filename="a.mp4"');
    expect(Buffer.concat(response.writes)).toEqual(body);
  });

  it('sends headers but no body for HEAD', async () => {
    // risk: a HEAD probe streams (and decrypts) the whole file.
    const response = new CapturingResponse();
    let read = false;
    const content = { size:3, mime:'text/plain', range:undefined, contentLength:3, body:(async function * () { read = true; yield Buffer.from('abc') })() } as any;
    await new FileStreamResponder().send({method:'HEAD'} as any, response as any, content);
    expect(response.headers['Content-Length']).toBe(3);
    expect(response.writes).toEqual([]);
    expect(read).toBe(false);
    expect(response.ended).toBe(true);
  });

  it('rejects with AbortError and stops reading when the client closes while waiting for drain', async () => {
    // risk: a cancelled download keeps decrypting chunks for a client that is gone.
    const response = new CapturingResponse();
    response.write = (chunk:Buffer) => { response.writes.push(chunk); setImmediate(() => response.emit('close')); return false };
    let produced = 0;
    const content = { size:8, mime:'application/octet-stream', range:undefined, contentLength:8,
      body:(async function * () { for (let i = 0; i < 4; i++) { produced++; yield Buffer.alloc(2, i) } })() } as any;
    await expect(new FileStreamResponder().send({method:'GET'} as any, response as any, content)).rejects.toMatchObject({ name:'AbortError' });
    expect(produced).toBe(1);
    expect(response.ended).toBe(false);
    expect(response.listenerCount('drain')).toBe(0);
  });
});
