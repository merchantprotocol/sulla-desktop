import type express from 'express';
import type { ByteRange } from './fileStream.js';

export interface StreamResponseContent {
  range:ByteRange | undefined;
  mime:string;
  contentLength:number;
  size:number;
  body:AsyncIterable<Buffer>;
}

/**
 * Writes stored file content to an HTTP response chunk by chunk: 200 or 206 with range headers,
 * no body for HEAD or empty content, back-pressure on `drain`, and an AbortError when the client
 * closes the connection mid-stream.
 */
export class FileStreamResponder {
  async send(request:express.Request, response:express.Response, content:StreamResponseContent, disposition?:string):Promise<void> {
    this.writeHeaders(response, content, disposition);
    if (request.method === 'HEAD' || content.contentLength === 0) { response.end(); return }
    for await (const part of content.body) {
      if (!response.write(part)) await this.drained(response);
    }
    response.end();
  }

  private writeHeaders(response:express.Response, content:StreamResponseContent, disposition?:string):void {
    response.status(content.range ? 206 : 200);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', content.mime);
    response.setHeader('Content-Length', content.contentLength);
    if (content.range) response.setHeader('Content-Range', `bytes ${ content.range.start }-${ content.range.end }/${ content.size }`);
    if (disposition) response.setHeader('Content-Disposition', disposition);
  }

  /** Resolves on `drain`; rejects with an AbortError if the client goes away first. */
  private drained(response:express.Response):Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { response.off('drain', drained); response.off('close', closed) };
      const drained = () => { cleanup(); resolve() };
      const closed = () => { cleanup(); reject(Object.assign(new Error('Media stream cancelled'), { name: 'AbortError' })) };
      response.once('drain', drained); response.once('close', closed);
    });
  }
}

const responder = new FileStreamResponder();

/** Kept for existing callers (app.ts, fileStream.ts re-export); delegates to FileStreamResponder. */
export function sendFileStream(request:express.Request, response:express.Response, content:StreamResponseContent, disposition?:string):Promise<void> {
  return responder.send(request, response, content, disposition);
}
