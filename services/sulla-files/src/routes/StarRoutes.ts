// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { StarPrincipal, StarRepository } from '../Repositories/StarRepository.js';

/** /v1/stars: per-principal stars. Agents star as themselves; humans as their user. */
export class StarRoutes {
  constructor(private readonly access:FilesAccessGate, private readonly stars:StarRepository) {}

  register(app:express.Express):void {
    app.get('/v1/stars', async(request:RequestWithIdentity, response, next) => { try {
      const collectionId = String(request.query.collectionId ?? ''); await this.access.requireCollection(request, collectionId, 'view', true, true); const principal = this.principal(request);
      const rows = await this.stars.list(principal, collectionId);
      const visible = []; for (const row of rows) { try { if (row.file_id) await this.access.requireFile(request, row.file_id, 'view'); else await this.access.requirePath(request, collectionId, row.folder_path!, 'view'); visible.push({ collectionId, fileId: row.file_id ?? undefined, folderPath: row.folder_path ?? undefined }) } catch { /* inaccessible stars are hidden */ } }
      response.json(visible);
    } catch (error) { next(error) } });
    app.put('/v1/stars', async(request:RequestWithIdentity, response, next) => { try {
      const { collectionId, fileId, folderPath } = this.target(request);
      const file = fileId ? await this.access.requireFile(request, fileId, 'view') : undefined; if (file && file.collection_id !== collectionId) throw new HttpError(400, 'file belongs to another collection');
      if (!file) await this.access.requirePath(request, collectionId, folderPath!, 'view'); const principal = this.principal(request);
      if (fileId) await this.stars.starFile(principal, collectionId, fileId);
      else await this.stars.starFolder(principal, collectionId, folderPath!);
      response.status(204).end();
    } catch (error) { next(error) } });
    app.delete('/v1/stars', async(request:RequestWithIdentity, response, next) => { try {
      const { collectionId, fileId, folderPath } = this.target(request);
      await this.access.requireCollection(request, collectionId, 'view', true, true); const principal = this.principal(request);
      await this.stars.unstar(principal, collectionId, fileId, folderPath);
      response.status(204).end();
    } catch (error) { next(error) } });
  }

  private principal(request:RequestWithIdentity):StarPrincipal {
    const actor = this.access.identity(request);
    return actor.agentId || actor.jobId ? { type: 'agent', id: actor.agentId || actor.jobId! } : { type: 'user', id: actor.userId };
  }

  private target(request:RequestWithIdentity):{ collectionId:string; fileId?:string; folderPath?:string } {
    const collectionId = String(request.body.collectionId ?? ''); const fileId = typeof request.body.fileId === 'string' ? request.body.fileId : undefined; const folderPath = typeof request.body.folderPath === 'string' ? FilesRequestInput.cleanPath(request.body.folderPath, false) : undefined;
    if (Boolean(fileId) === Boolean(folderPath)) throw new HttpError(400, 'provide exactly one fileId or folderPath');
    return { collectionId, fileId, folderPath };
  }
}
