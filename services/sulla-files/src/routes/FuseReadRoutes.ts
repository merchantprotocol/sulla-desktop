// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { FuseTreeRepository } from '../Repositories/FuseTreeRepository.js';
import type { FuseTreeSnapshotCache } from '../Services/FuseTreeSnapshotCache.js';

/** The Files mount's read side: one directory page, one entry, and the whole cached home tree. */
export class FuseReadRoutes {
  constructor(
    private readonly access:FilesAccessGate,
    private readonly tree:FuseTreeRepository,
    private readonly snapshots:FuseTreeSnapshotCache,
    /** Throws 404 unless the experimental mount is enabled on this desktop. */
    private readonly requireMount:() => unknown,
    private readonly userId:string,
  ) {}

  register(app:express.Express):void {
    // FUSE v2 reads one directory at a time. The generated parent_path indexes
    // make both the keyset cursor and direct-child predicate bounded by the page.
    app.get('/v1/fuse/directory', async(request:RequestWithIdentity, response, next) => { try {
      this.requireMount(); this.access.identity(request);
      const path = FilesRequestInput.cleanPath(String(request.query.path ?? ''), true);
      const collectionId = String(request.query.collectionId ?? '') || await this.tree.homeCollectionId(this.userId);
      if (!collectionId) throw new HttpError(404, 'Files collection not found');
      await this.access.requireCollection(request, collectionId, 'view');
      const revision = await this.tree.revision();
      const etag = `"dir:${ collectionId }:${ path }:${ revision }"`; response.setHeader('ETag', etag); response.setHeader('Cache-Control', 'private, no-cache');
      if (request.header('if-none-match') === etag) return response.status(304).end();
      const rawLimit = Number(request.query.limit ?? 500); const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 500));
      const cursor = String(request.query.cursor ?? '');
      const rows = await this.tree.directoryPage(collectionId, path, cursor, limit + 1);
      const entries = rows.slice(0, limit); const hasMore = rows.length > limit;
      response.json({ rootCollectionId: collectionId, entries, nextCursor: hasMore ? entries[entries.length - 1].path : null, revision });
    } catch (error) { next(error) } });
    app.get('/v1/fuse/entry', async(request:RequestWithIdentity, response, next) => { try {
      this.requireMount(); this.access.identity(request);
      const collectionId = String(request.query.collectionId ?? '') || await this.tree.homeCollectionId(this.userId);
      const path = FilesRequestInput.cleanPath(String(request.query.path ?? ''), false);
      if (!collectionId) throw new HttpError(404, 'Files collection not found');
      await this.access.requireCollection(request, collectionId, 'view');
      const entry = await this.tree.entry(collectionId, path);
      if (!entry) throw new HttpError(404, 'Files entry not found'); response.json(entry);
    } catch (error) { next(error) } });
    app.get('/v1/fuse/tree', async(request:RequestWithIdentity, response, next) => { try {
      this.requireMount();
      this.access.identity(request);
      const currentRevision = await this.snapshots.revision();
      // The one Files mount serves the home collection; there are no other mounted areas.
      const area = '';
      const etag = `"${ area || 'home' }:${ currentRevision }"`;
      response.setHeader('Cache-Control', 'private, no-cache');
      response.setHeader('ETag', etag);
      if (request.header('if-none-match') === etag) return response.status(304).end();
      const snapshot = await this.snapshots.load(area);
      response.setHeader('ETag', `"${ area || 'home' }:${ snapshot.revision }"`);
      response.type('application/json').send(snapshot.body);
    } catch (error) { next(error) } });
  }
}
