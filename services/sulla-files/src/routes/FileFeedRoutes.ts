// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { CollectionFilesFeed } from '../CollectionFilesFeed.js';
import { lifecycleCapabilities, lifecycleFields } from '../documentLifecycle.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import { isProtectedPath } from '../protectedFiles.js';

/**
 * Cross-folder views: recent files, collection stats and child-folder summaries. Each reads its own
 * bounded server query; clients only hold the open folder's rows.
 */
export class FileFeedRoutes {
  constructor(private readonly access:FilesAccessGate, private readonly feed:CollectionFilesFeed) {}

  register(app:express.Express):void {
    app.get('/v1/files/recent', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId = this.collectionId(request);
      const access = await this.access.requireCollection(request, collectionId, 'view', true, true);
      let rows:any[]; try { rows = await this.feed.recent({ collectionId, limit: request.query.limit, createdByType: request.query.createdByType }) } catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error }
      response.json(rows.filter(row => !isProtectedPath(row.path)).map(row => ({ ...lifecycleFields({ ...row, size: Number(row.size) }), capabilities: lifecycleCapabilities(access.role, true) })));
    } catch (error) { next(error) } });
    app.get('/v1/files/stats', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId = this.collectionId(request);
      await this.access.requireCollection(request, collectionId, 'view', true, true);
      response.json(await this.feed.stats(collectionId));
    } catch (error) { next(error) } });
    app.get('/v1/folders/summary', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId = this.collectionId(request);
      const path = FilesRequestInput.cleanPath(String(request.query.path ?? '')); await this.access.requireCollection(request, collectionId, 'view', true, true);
      const visible = [];
      for (const summary of await this.feed.folderSummaries(collectionId, path)) {
        const folderPath = path ? `${ path }/${ summary.name }` : summary.name; if (isProtectedPath(folderPath)) continue;
        try { await this.access.requirePath(request, collectionId, folderPath, 'view'); visible.push({ path: folderPath, ...summary }) } catch (error:any) { if (error.status !== 403) throw error }
      }
      response.json(visible);
    } catch (error) { next(error) } });
  }

  private collectionId(request:RequestWithIdentity):string {
    const collectionId = String(request.query.collectionId ?? ''); if (!collectionId) throw new HttpError(400, 'collectionId is required');
    return collectionId;
  }
}
