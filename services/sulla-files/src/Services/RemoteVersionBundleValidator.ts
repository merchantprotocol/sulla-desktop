// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { HttpError } from '../Http/HttpError.js';

/** Stored-chunk metadata a remote bundle declares for each chunk of its manifest. */
export interface RemoteChunkMetadata { size:number; storedSize:number; location:string }

/** Checks a remote version bundle is self-consistent: ids, tombstone shape, authenticated manifest and exact chunk metadata. */
export class RemoteVersionBundleValidator {
  /** The bundle's chunk metadata by chunk id (empty for a tombstone); throws 400 on any inconsistency. */
  chunkMetadata(bundle:any):Map<string, RemoteChunkMetadata> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(String(bundle?.file?.id ?? '')) || !uuid.test(String(bundle?.version?.id ?? ''))) throw new HttpError(400, 'valid file and version ids are required');
    if (!bundle?.manifest) {
      if (!bundle?.version?.deleted || Number(bundle.version.size) !== 0) throw new HttpError(400, 'non-deleted versions require a manifest');
      return new Map();
    }
    if (bundle.version.deleted) throw new HttpError(400, 'deleted versions cannot carry a manifest');
    const ids = bundle.manifest.chunk_ids;
    const totalSize = Number(bundle.manifest.total_size);
    if (!Array.isArray(ids) || !ids.length || ids.some((id:unknown) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || !Number.isSafeInteger(totalSize) || totalSize < 0) throw new HttpError(400, 'invalid manifest metadata');
    if (Number(bundle.version.size) !== totalSize || Number(bundle.file?.size) !== totalSize) throw new HttpError(400, 'manifest and version sizes do not match');
    const expectedHash = createHash('sha256').update(JSON.stringify({ ids, size: totalSize })).digest('hex');
    if (bundle.manifest.hash !== expectedHash) throw new HttpError(400, 'manifest hash does not authenticate its chunk list');
    if (!Array.isArray(bundle.chunks)) throw new HttpError(400, 'chunk metadata is required');
    const chunks = new Map<string, RemoteChunkMetadata>();
    for (const chunk of bundle.chunks) {
      const size = Number(chunk?.size); const storedSize = Number(chunk?.stored_size);
      if (typeof chunk?.id !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.id) || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(storedSize) || storedSize < 0 || typeof chunk.location !== 'string') throw new HttpError(400, 'invalid chunk metadata');
      chunks.set(chunk.id, { size, storedSize, location: chunk.location });
    }
    if (bundle.chunks.length !== chunks.size || chunks.size !== new Set(ids).size || ids.some((id:string) => !chunks.has(id))) throw new HttpError(400, 'chunk metadata must exactly match the manifest');
    return chunks;
  }
}
