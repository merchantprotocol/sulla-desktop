// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import { ContentReadFailureLog } from '../ContentReadFailureLog.js';
import { RangeNotSatisfiableError } from '../fileStream.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import type { SharesService } from '../shares.js';

/** Share links (/v1/links) and the authenticated local share relay (/v1/local/shares). */
export class ShareRoutes {
  constructor(
    private readonly access:FilesAccessGate,
    private readonly shares:SharesService,
    private readonly contentReadFailures:ContentReadFailureLog,
  ) {}

  register(app:express.Express):void {
    app.get('/v1/local/shares/:id/content', (request, response, next) => { void this.streamContent(request, response, next) });
    // Narrow contract for the future public viewer/relay. It validates the link
    // policy and returns metadata only; content stays on the authenticated local
    // relay route above until the visitor viewer lands.
    app.post('/v1/local/shares/:id/authorize', async(request, response, next) => { try { response.json(await this.shares.authorize(request.params.id, { password: typeof request.body.password === 'string' ? request.body.password : undefined, wantsDownload: request.body.download === true })) } catch (error) { next(error) } });
    app.post('/v1/links', async(request:RequestWithIdentity, response, next) => {
      try {
        if (request.body.fileId) await this.access.requireFile(request, String(request.body.fileId), 'view');
        else await this.access.requirePath(request, String(request.body.collectionId ?? ''), FilesRequestInput.cleanPath(request.body.folderPath, false), 'view');
        response.status(201).json(await this.shares.create(this.owner(request), request.body));
      } catch (error) { next(error) }
    });
    app.get('/v1/links', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.shares.list(this.owner(request))) } catch (error) { next(error) } });
    app.get('/v1/links/activity', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.shares.activity(this.owner(request))) } catch (error) { next(error) } });
    app.get('/v1/links/:id/activity', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.shares.activity(this.owner(request), request.params.id)) } catch (error) { next(error) } });
    app.delete('/v1/links/:id', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.shares.revoke(this.owner(request), request.params.id)) } catch (error) { next(error) } });
    app.patch('/v1/links/:id', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.shares.update(this.owner(request), request.params.id, request.body)) } catch (error) { next(error) } });
    app.post('/v1/links/:id/restore', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.shares.restore(this.owner(request), request.params.id, typeof request.body.password === 'string' ? request.body.password : undefined)) } catch (error) { next(error) } });
  }

  private owner(request:RequestWithIdentity):{ user:string; device:string } {
    const actor = this.access.identity(request);
    return { user: actor.userId, device: actor.deviceId || '' };
  }

  private async streamContent(request:express.Request<{ id:string }>, response:express.Response, next:express.NextFunction):Promise<void> {
    const controller = new AbortController(); const abort = () => controller.abort();
    request.once('aborted', abort); response.once('close', abort);
    try {
      const content = await this.shares.streamContent(request.params.id, String(request.query.path ?? ''), request.header('range'), controller.signal);
      response.status(content.status).type(content.mime).setHeader('X-Sulla-Filename', encodeURIComponent(content.name));
      response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('Content-Length', content.contentLength);
      if (content.contentRange) response.setHeader('Content-Range', content.contentRange);
      for await (const part of content.body) {
        if (!response.write(part)) await new Promise<void>((resolve, reject) => {
          const cleanup = () => { response.off('drain', drained); response.off('close', closed) };
          const drained = () => { cleanup(); resolve() };
          const closed = () => { cleanup(); reject(Object.assign(new Error('Share stream cancelled'), { name: 'AbortError' })) };
          response.once('drain', drained); response.once('close', closed);
        });
      }
      response.end();
    } catch (error) {
      if (!controller.signal.aborted && ContentReadFailureLog.isServerFailure(error)) this.contentReadFailures.report(error, { route: 'share-content', shareId: request.params.id });
      if (error instanceof RangeNotSatisfiableError && !response.headersSent) { response.status(416).setHeader('Accept-Ranges', 'bytes'); response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('Content-Range', `bytes */${ error.size }`); response.setHeader('Content-Length', '0'); response.end(); return }
      if (!controller.signal.aborted && !response.headersSent) next(error); else if (!controller.signal.aborted) response.destroy(error as Error);
    } finally { request.off('aborted', abort); response.off('close', abort) }
  }
}
