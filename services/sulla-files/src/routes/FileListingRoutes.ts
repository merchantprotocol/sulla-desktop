// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import { lifecycleCapabilities, lifecycleFields } from '../documentLifecycle.js';
import { FileListingQuery } from '../FileListingQuery.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import { ListingPage } from '../ListingPage.js';
import { isAuditLogPath, isProtectedPath } from '../protectedFiles.js';
import type { FileListingRepository } from '../Repositories/FileListingRepository.js';

/** GET /v1/files: a collection's files under a folder, keyset-paged or capped at the legacy row limit. */
export class FileListingRoutes {
  constructor(
    private readonly access:FilesAccessGate,
    private readonly listings:FileListingRepository,
    private readonly listingQuery = new FileListingQuery(),
  ) {}

  register(app:express.Express):void {
    app.get('/v1/files', (request:RequestWithIdentity, response, next) => { this.list(request, response).catch(next) });
  }

  private async list(request:RequestWithIdentity, response:express.Response):Promise<void> {
    const collectionId = String(request.query.collectionId ?? ''); if (!collectionId) throw new HttpError(400, 'collectionId is required');
    const path = FilesRequestInput.cleanPath(String(request.query.path ?? '')); const access = await this.access.requireCollection(request, collectionId, 'view', true, true); const trash = request.query.trash === 'true';
    const paged=ListingPage.isRequested(request.query.limit,request.query.cursor);
    let pageRequest:ListingPage; try { pageRequest=ListingPage.parse(request.query.limit,request.query.cursor); } catch { throw new HttpError(400,'invalid listing cursor'); }
    const scope=this.listingQuery.build({ collectionId, path, childrenOnly:request.query.children==='true', trash, deviceId:typeof request.query.deviceId==='string'?request.query.deviceId:undefined, after:pageRequest.after, limit:(paged ? pageRequest.limit : ListingPage.legacyMaxRows)+1 });
    const rows = await this.listings.page(scope);
    if(!paged && rows.length>ListingPage.legacyMaxRows) throw new HttpError(413,'listing exceeds the 20,000-row compatibility limit; use limit and cursor pagination');
    const hasMore=paged && rows.length>pageRequest.limit; const page=rows.slice(0,paged?pageRequest.limit:ListingPage.legacyMaxRows); if(paged) pageRequest.apply(response,hasMore,page.at(-1)?.path);
    this.access.identity(request); const visible = [];
    for (const row of page.filter(row => !row.path || !isProtectedPath(row.path) || (access.collection.system_area === 'logs' && isAuditLogPath(row.path)))) {
      const role = access.role;
      const versionId = row.current_version_id;
      if (!versionId) continue;
      const version = row;
      const draftVisible = true;
      visible.push({ ...lifecycleFields({ ...row, current_version_id: versionId, size: Number(version?.size ?? row.size), version_created_at: version?.created_at, version_created_by_type: version?.created_by_type, version_created_by_id: version?.created_by_id }), capabilities: lifecycleCapabilities(role, draftVisible) });
    }
    response.json(visible);
  }
}
