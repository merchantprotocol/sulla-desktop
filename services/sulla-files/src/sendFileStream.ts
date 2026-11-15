import type express from 'express';
import type { ByteRange } from './fileStream.js';

interface StreamResponseContent {
  range:ByteRange | undefined;
  mime:string;
  contentLength:number;
  size:number;
  body:AsyncIterable<Buffer>;
}

export async function sendFileStream(request:express.Request, response:express.Response, content:StreamResponseContent, disposition?:string):Promise<void> {
  response.status(content.range ? 206 : 200);
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Type', content.mime);
  response.setHeader('Content-Length', content.contentLength);
  if (content.range) response.setHeader('Content-Range', `bytes ${ content.range.start }-${ content.range.end }/${ content.size }`);
  if (disposition) response.setHeader('Content-Disposition', disposition);
  if (request.method === 'HEAD' || content.contentLength === 0) { response.end(); return }
  for await (const part of content.body) {
    if (!response.write(part)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { response.off('drain', drained); response.off('close', closed) };
        const drained = () => { cleanup(); resolve() };
        const closed = () => { cleanup(); reject(Object.assign(new Error('Media stream cancelled'), { name: 'AbortError' })) };
        response.once('drain', drained); response.once('close', closed);
      });
    }
  }
  response.end();
}
