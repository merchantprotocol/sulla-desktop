// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { Config } from '../config.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { FuseTreeRepository } from '../Repositories/FuseTreeRepository.js';
import type { FuseTreeSnapshotCache } from '../Services/FuseTreeSnapshotCache.js';

/**
 * The Files mount's read side: one directory page, one entry, and the whole cached home tree.
 *
 * `owner` is the live Files config, read on every request: the app is built before Vault unlocks,
 * and VaultPrincipalAdoption then moves config.userId from the "desktop-user" sentinel to the
 * Vault principal (and re-owns the collections). A userId copied at build time found no home
 * collection after unlock, so every collection-less FUSE request answered 404.
 */
export class FuseReadRoutes {
  constructor(
    private readonly access:FilesAccessGate,
    private readonly tree:FuseTreeRepository,
    private readonly snapshots:FuseTreeSnapshotCache,
    /** Throws 404 unless the experimental mount is enabled on this desktop. */
    private readonly requireMount:() => unknown,
    private readonly owner:Readonly<Pick<Config, 'userId'>>,
  ) {}

  /** The requested collection, or the current owner's home collection when none was named. */
  private async collection(route:string, request:RequestWithIdentity):Promise<string> {
    const requested = String(request.query.collectionId ?? '');
    const collectionId = requested || await this.tree.homeCollectionId(this.owner.userId);
    if (!collectionId) {
      this.refused(route, '', `no home collection for owner ${ this.owner.userId }`);
      throw new HttpError(404, 'Files collection not found');
    }
    try {
      await this.access.requireCollection(request, collectionId, 'view');
    } catch (error) {
      this.refused(route, collectionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return collectionId;
  }

  /** A refused collection lookup is never silent: the mount retries it forever otherwise. */
  private refused(route:string, collectionId:string, reason:string):void {
    console.warn('[SullaFiles] fuse-lookup-refused', JSON.stringify({ route, collectionId: collectionId || null, reason }));
  }

  register(app:express.Express):void {
    // 068's revision is global, so never expose cross-collection paths here. A change asks
    // this mount to invalidate its known tree; authenticated directory reads then refresh only
    // data the principal can view.
    app.get('/v1/fuse/changes', async(request:RequestWithIdentity, response, next) => { try {
      this.requireMount(); this.access.identity(request);
      const collectionId = await this.collection('/v1/fuse/changes', request);
      const revision = await this.tree.revision();
      const since = String(request.query.since ?? '');
      response.setHeader('Cache-Control', 'private, no-store');
      response.json({ collectionId, revision, reset: !/^\d+$/.test(since) || since !== revision, changes: [] });
    } catch (error) { next(error) } });
    // FUSE v2 reads one directory at a time. The generated parent_path indexes
    // make both the keyset cursor and direct-child predicate bounded by the page.
    app.get('/v1/fuse/directory', async(request:RequestWithIdentity, response, next) => { try {
      this.requireMount(); this.access.identity(request);
      const path = FilesRequestInput.cleanPath(String(request.query.path ?? ''), true);
      const collectionId = await this.collection('/v1/fuse/directory', request);
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
      const path = FilesRequestInput.cleanPath(String(request.query.path ?? ''), false);
      const collectionId = await this.collection('/v1/fuse/entry', request);
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
