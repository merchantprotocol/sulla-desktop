// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Document lifecycle entry point. The work lives in classes:
 *   Services/DocumentLifecycleRoutes (HTTP), Services/DocumentPublicationService (draft → published),
 *   Services/LifecycleRecordsService (checkout, retention, record locks, disposal, state sync),
 *   Services/FilePurgeService (permanent disposal), Services/ChunkGcDrainer (physical chunk GC),
 *   Repositories/{DocumentLifecycle,FilePurge,ChunkGc}Repository (SQL).
 * The free functions below are kept so app.ts and retiredSystemAreas.ts keep compiling.
 */

import { ChunkGcDrainer, type DeleteChunk } from './Services/ChunkGcDrainer.js';
import { DocumentLifecycleRoutes, type DocumentLifecycleDeps } from './Services/DocumentLifecycleRoutes.js';
import { DocumentLifecycleView } from './Services/DocumentLifecycleView.js';
import { LifecycleHttpError } from './Services/LifecycleHttpError.js';
import { DocumentLifecycleRepository } from './Repositories/DocumentLifecycleRepository.js';

import type express from 'express';
import type pg from 'pg';

export { ChunkGcDrainer } from './Services/ChunkGcDrainer.js';
export { DocumentLifecycleRoutes } from './Services/DocumentLifecycleRoutes.js';
export { DocumentLifecycleView } from './Services/DocumentLifecycleView.js';

/** Resolves which version of a file a reader may open (the requested one, else current). */
export class AuthorizedVersionResolver {
  constructor(private readonly lifecycle:DocumentLifecycleRepository) {}

  async resolve(file:any, _draftVisible:boolean, requested?:string):Promise<string> {
    const versionId = requested ?? file.current_version_id;
    if (!versionId) throw LifecycleHttpError.of(404, 'no version is available');
    const version = await this.lifecycle.liveVersionId(versionId, file.id);
    if (!version) throw LifecycleHttpError.of(404, 'version not found');
    return version;
  }
}

/** @deprecated use DocumentLifecycleView#fields */
export function lifecycleFields(file:any) { return new DocumentLifecycleView().fields(file) }

/** @deprecated use DocumentLifecycleView#capabilities */
export function lifecycleCapabilities(role:string | undefined, draftVisible:boolean) { return new DocumentLifecycleView().capabilities(role, draftVisible) }

/** @deprecated use AuthorizedVersionResolver */
export function authorizedVersionId(db:pg.Pool, file:any, draftVisible:boolean, requested?:string):Promise<string> {
  return new AuthorizedVersionResolver(new DocumentLifecycleRepository(db)).resolve(file, draftVisible, requested);
}

/** @deprecated use ChunkGcDrainer */
export function drainPendingChunkGc(db:pg.Pool, deleteChunk:DeleteChunk, maxBatches = 5):Promise<void> {
  return new ChunkGcDrainer(db).drain(deleteChunk, maxBatches);
}

/** @deprecated use DocumentLifecycleRoutes */
export function registerDocumentLifecycleRoutes(app:express.Express, db:pg.Pool, deps:DocumentLifecycleDeps):void {
  new DocumentLifecycleRoutes(db, deps).register(app);
}
