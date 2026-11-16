// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Delegating shims for callers outside the E5 S5 slice (app.ts, indexing.ts, search.ts,
// recordingEnrichment.ts). The mirror is Services/SystemAreaMirror.ts and its SQL is
// Repositories/SystemAreaIngestRepository.ts; each call builds them from the passed-in pool.
import { TransactionRunner } from './FilesTransaction.js';
import { SystemAreaIngestRepository, type SystemAreaQueryable } from './Repositories/SystemAreaIngestRepository.js';
import { SystemAreaMirror, type MirroredSystemFile, type SystemAreaMirrorInput, type SystemAreaMirrorSteps } from './Services/SystemAreaMirror.js';

import type pg from 'pg';

export { SystemAreaMirror, type MirroredSystemFile } from './Services/SystemAreaMirror.js';

export const SKIP_SEARCH_INDEX_HEADER = SystemAreaMirror.skipSearchIndexHeader;
export const UNINDEXED_SYSTEM_AREAS:ReadonlySet<string> = SystemAreaMirror.unindexedAreas;

export type Queryable = SystemAreaQueryable;
export interface ConnectionPool { connect():Promise<Queryable & { release():void }> }

export function isSystemArea(systemArea:unknown):boolean { return SystemAreaMirror.isSystemArea(systemArea) }

export function shouldSkipSearchIndex(headerValue:string | undefined, systemArea:unknown):boolean {
  return SystemAreaMirror.shouldSkipSearchIndex(headerValue, systemArea);
}

export function skipSearchIndexForVersion(client:Queryable, fileId:string, versionId:string):Promise<void> {
  return new SystemAreaIngestRepository().skipSearchIndex(client, fileId, versionId);
}

export function mirrorSystemAreaFile(db:ConnectionPool, input:SystemAreaMirrorInput, deps:SystemAreaMirrorSteps):Promise<MirroredSystemFile> {
  return new SystemAreaMirror(new TransactionRunner(db as unknown as pg.Pool), new SystemAreaIngestRepository()).mirror(input, deps);
}
