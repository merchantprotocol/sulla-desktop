// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import { lifecycleFields } from '../documentLifecycle.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import { assertUnprotectedFile, isProtectedPath } from '../protectedFiles.js';
import type { CollectionSyncRepository } from '../Repositories/CollectionSyncRepository.js';

/** Collection list/registration, the collection change journal, and version / recording metadata reads. */
export class CollectionSyncRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly access:FilesAccessGate,
    private readonly collections:CollectionSyncRepository,
  ) {}

  /** GET /v1/collections (mounted at its original position, before the agent file routes). */
  registerListing(app:express.Express):void {
    app.get('/v1/collections', async(request:RequestWithIdentity, response, next) => { try {
      const rows = await this.collections.listed();
      const visible = [];
      for (const collection of rows) {
        try {
          const access = await this.access.collectionAccess(request, collection.id);
          visible.push({ ...collection, systemArea: collection.system_area ?? null, access_role: access.role, shared_folders: access.paths, shared_files: access.files });
        } catch (error) {
          if ((error as HttpError).status !== 403) throw error;
        }
      }
      response.json(visible);
    } catch (error) { next(error) } });
  }

  register(app:express.Express):void {
    const { identity, requireCollection, requireFile, visibleVersion } = this.access;
    app.post('/v1/collections', async(request:RequestWithIdentity, response, next) => {
      try {
        const actor = identity(request); const collection = request.body.collection;
        if (collection.kind !== 'knowledge') throw new HttpError(400, 'only knowledge syncs');
        await this.collections.createKnowledge(actor.userId, collection);
        response.json({ ok: true });
      } catch (error) { next(error) }
    });
    app.get('/v1/collections/:id/journal', async(request:RequestWithIdentity, response, next) => { try {
      await requireCollection(request, request.params.id, 'view', true, true); const after = Number(request.query.after ?? 0);
      const since = Number.isSafeInteger(after) ? after : 0;
      // UI change feed: never serialize manifests, key context, or file contents.
      if (request.query.changesOnly === 'true') {
        if (request.query.head === 'true') {
          response.json({ seq: await this.collections.journalHead(request.params.id), paths: [], more: false });
          return;
        }
        const changes = await this.collections.changedPaths(request.params.id, since);
        const entries = changes.filter(row => !isProtectedPath(row.path));
        // Advance past protected rows too, without revealing their paths.
        response.json({ seq: String(changes.at(-1)?.seq ?? since), paths: entries.map(row => row.path), more: changes.length === 1000 });
        return;
      }
      const rows = await this.collections.journalEntries(request.params.id, since);
      identity(request); const entries:any[] = [];
      for (const row of rows.filter(row => !isProtectedPath(row.file.path))) {
        const draftVisible = true; const canEdit = true;
        const visibleFile = row.file;
        entries.push({ ...row, file: lifecycleFields(visibleFile), syncAuthority: { canEdit, canViewDraft: draftVisible, canMaterialize: row.version.deleted || row.version.publication_status === 'published' || draftVisible } });
      }
      for (const tombstone of await this.collections.purgeTombstones(request.params.id, since)) {
        if (isProtectedPath(tombstone.path)) continue;
        entries.push({ seq:tombstone.seq,collection_id:tombstone.collection_id,file_id:tombstone.file_id,op:'purge',at:tombstone.purged_at,
          file:{id:tombstone.file_id,collection_id:tombstone.collection_id,path:tombstone.path,lifecycle_generation:tombstone.lifecycle_generation},
          syncAuthority:{canEdit:true,canViewDraft:true,canMaterialize:true} });
      }
      response.json(entries.sort((left, right) => Number(left.seq) - Number(right.seq)).slice(0, 1000));
    } catch (error) { next(error) } });
    app.get('/v1/versions/:id', async(request:RequestWithIdentity, response, next) => { try {
      const bundle = await this.collections.versionBundle(request.params.id); if (!bundle) return response.sendStatus(404);
      await assertUnprotectedFile(this.db, bundle.file); const file = await requireFile(request, bundle.file.id, 'view'); await visibleVersion(request, file, request.params.id); response.json(bundle);
    } catch (error) { next(error) } });
    app.get('/v1/files/:id/recording-metadata', async(request:RequestWithIdentity, response, next) => { try {
      const file = await requireFile(request, request.params.id, 'view'); const versionId = await visibleVersion(request, file);
      const row = await this.collections.recordingMetadata(request.params.id, versionId);
      if (!row) return response.sendStatus(404);
      await assertUnprotectedFile(this.db, { id: request.params.id, path: row.path });
      const { collection_id: _collectionId, path: _path, ...metadata } = row; response.json(metadata);
    } catch (error) { next(error) } });
  }
}
