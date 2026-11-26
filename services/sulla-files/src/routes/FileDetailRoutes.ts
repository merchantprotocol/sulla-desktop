// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import type { Config } from '../config.js';
import { ContentReadFailureLog } from '../ContentReadFailureLog.js';
import { authorizedVersionId, lifecycleCapabilities, lifecycleFields } from '../documentLifecycle.js';
import { RangeNotSatisfiableError, sendFileStream, streamFileContent } from '../fileStream.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import { thumbnail } from '../preview.js';
import { isProtectedPath } from '../protectedFiles.js';
import type { FileDetailRepository } from '../Repositories/FileDetailRepository.js';
import type { Store } from '../store.js';

/** GET /v1/files/:id and its read-only views: preview, download, thumbnail and version history. */
export class FileDetailRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly details:FileDetailRepository,
    private readonly audit:RequestAuditLog,
    private readonly contentReadFailures:ContentReadFailureLog,
  ) {}

  /** Mounted where the inline handlers were: after the POST /v1/files/:id actions, before PUT content. */
  register(app:express.Express):void {
    app.get('/v1/files/:id', async(request:RequestWithIdentity, response, next) => { try { response.json(await this.detail(request)) } catch (error) { next(error) } });
    app.get('/v1/files/:id/preview', (request:RequestWithIdentity, response, next) => this.stream(request, response, next));
    app.get('/v1/files/:id/download', (request:RequestWithIdentity, response, next) => this.stream(request, response, next, true));
    app.get('/v1/files/:id/thumbnail', async(request:RequestWithIdentity, response, next) => { try { const file = await this.access.requireFile(request, request.params.id, 'view'); const versionId = await this.access.visibleVersion(request, file, typeof request.query.versionId === 'string' ? request.query.versionId : undefined); const content = await thumbnail(this.db, this.config, this.store, file.id, versionId); if (!content) return response.sendStatus(404); return this.sendContent(request, response, content, 'private, max-age=86400') } catch (error) { next(error) } });
    app.get('/v1/files/:id/history', async(request:RequestWithIdentity, response, next) => { try { await this.access.requireFile(request, request.params.id, 'view'); const rows = await this.details.history(request.params.id); response.json(rows.filter(row => !row.path || !isProtectedPath(row.path))) } catch (error) { next(error) } });
  }

  private async detail(request:RequestWithIdentity):Promise<unknown> {
    const file = await this.access.requireFile(request, request.params.id, 'view');
    const access = await this.access.collectionAccess(request, file.collection_id);
    const effectiveRole = access.role;
    const draftVisible = effectiveRole === 'manage';
    // A trashed file points at a deleted tombstone. Detail remains available for
    // retention and disposal decisions, but it must not use that tombstone to
    // broaden version/content visibility.
    const versionId = file.deleted_at ? undefined : await authorizedVersionId(this.db, file, draftVisible);
    const [version, recording, edgeRows, activity] = await Promise.all([
      versionId ? this.details.version(versionId) : Promise.resolve(undefined),
      versionId ? this.details.recording(file.id, versionId) : Promise.resolve(undefined),
      this.details.edges(file.id),
      this.details.activity(file.id, draftVisible),
    ]);
    const links = [];
    for (const edge of edgeRows) {
      if (edge.src_type !== 'file' || edge.dst_type !== 'file') continue;
      try {
        const linked = await this.access.requireFile(request, edge.linked_id, 'view');
        links.push({ id: linked.id, path: linked.path, mime: linked.mime, kind: edge.kind, direction: edge.src_id === file.id ? 'outgoing' : 'incoming', createdAt: edge.created_at });
      } catch { /* A relationship never grants access to its other endpoint. */ }
    }
    const inherited:any[] = [];
    return { ...lifecycleFields({ ...file, current_version_id: versionId ?? file.current_version_id }), capabilities: lifecycleCapabilities(effectiveRole, draftVisible), provenance: { type: file.created_by_type, id: file.created_by_id }, version: version ?? null, recording: recording ?? null, links, activity, access: { role: effectiveRole, inherited } };
  }

  private async stream(request:RequestWithIdentity, response:express.Response, next:express.NextFunction, download = false):Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort); response.once('close', abort);
    let readVersionId:string | undefined;
    try {
      const file = await this.access.requireFile(request, request.params.id, 'view');
      const versionId = readVersionId = await this.access.visibleVersion(request, file, typeof request.query.versionId === 'string' ? request.query.versionId : undefined);
      const content = await streamFileContent(this.db, this.config, this.store, file.id, versionId, request.header('range'), controller.signal);
      if (!content) { response.sendStatus(404); return }
      await this.audit.record(request, download ? 'download' : 'preview', { ...file, current_version_id: content.versionId });
      const originalName = content.path.split('/').at(-1) || 'download';
      const fallbackName = originalName.replace(/[^\x20-\x7E]|["\\]/g, '_');
      const disposition = `attachment; filename="${ fallbackName }"; filename*=UTF-8''${ encodeURIComponent(originalName) }`;
      await sendFileStream(request, response, content, download ? disposition : undefined);
    } catch (error) {
      if (!controller.signal.aborted && ContentReadFailureLog.isServerFailure(error)) this.contentReadFailures.report(error, { route: download ? 'download' : 'preview', fileId: request.params.id, versionId: readVersionId });
      if (error instanceof RangeNotSatisfiableError && !response.headersSent) { response.status(416).setHeader('Accept-Ranges', 'bytes'); response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('Content-Range', `bytes */${ error.size }`); response.end(); return }
      if (!controller.signal.aborted && !response.headersSent) next(error);
      else if (!controller.signal.aborted) response.destroy(error as Error);
    } finally { request.off('aborted', abort); response.off('close', abort) }
  }

  /** Sends an in-memory body, honouring a single bytes= range. */
  private sendContent(request:express.Request, response:express.Response, content:{ buffer: Buffer; mime: string }, cache = 'private, max-age=300') {
    response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Cache-Control', cache); response.type(content.mime); const range = request.header('range'); if (!range) return response.send(content.buffer);
    const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match) return response.status(416).end(); const start = match[1] ? Number(match[1]) : 0; const end = match[2] ? Number(match[2]) : content.buffer.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= content.buffer.length) return response.status(416).end();
    response.status(206).setHeader('Content-Range', `bytes ${ start }-${ end }/${ content.buffer.length }`); response.setHeader('Content-Length', end - start + 1); return response.send(content.buffer.subarray(start, end + 1));
  }
}
