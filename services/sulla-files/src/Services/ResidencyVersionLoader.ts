// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { maxEncryptedChunkBytes } from '../crypto.js';
import { assertUnprotectedFile } from '../protectedFiles.js';
import { ResidencyVersionGeometry } from './ResidencyVersionGeometry.js';

import type { ChunkMetadataRow, FileResidencyRepository } from '../Repositories/FileResidencyRepository.js';
import type { ResidencyVersion } from './ResidencyContracts.js';
import type pg from 'pg';

const CHUNK_BYTES = ResidencyVersionGeometry.chunkBytes;

/** Loads a file's current version and refuses protected files or any inconsistent chunk geometry. */
export class ResidencyVersionLoader {
  constructor(
    private readonly db:Pick<pg.Pool, 'query'>,
    private readonly rows:FileResidencyRepository,
  ) {}

  async loadCurrent(fileId:string):Promise<ResidencyVersion> {
    const row = await this.rows.findCurrentVersion(fileId);
    if (!row) throw new Error('Current file version is unavailable');
    await assertUnprotectedFile(this.db, { id: row.file_id, path: row.path });
    const size = Number(row.size);
    const ids = Array.isArray(row.chunk_ids) ? row.chunk_ids.map(String) : [];
    const expectedCount = Math.max(1, Math.ceil(size / CHUNK_BYTES));
    if (!Number.isSafeInteger(size) || size < 0 || Number(row.total_size) !== size || ids.length !== expectedCount) {
      throw new Error('File manifest has invalid chunk geometry');
    }
    const rows = await this.rows.findChunkMetadata(row.chunk_collection_id, ids);
    const metadata = new Map<string, ChunkMetadataRow>(rows.map(value => [String(value.id), value]));
    const chunks = ids.map((id, index) => {
      const value = metadata.get(id);
      const plainSize = index < ids.length - 1 ? CHUNK_BYTES : size - CHUNK_BYTES * (ids.length - 1);
      const storedSize = Number(value?.stored_size);
      if (!value || Number(value.size) !== plainSize || !Number.isSafeInteger(storedSize) || storedSize < 0 || storedSize > maxEncryptedChunkBytes(plainSize)) {
        throw new Error(`Missing or invalid chunk metadata for ${ id }`);
      }
      return { id, size: plainSize, storedSize };
    });
    return {
      fileId:            row.file_id,
      path:              row.path,
      versionId:         row.version_id,
      collectionId:      row.collection_id,
      chunkCollectionId: row.chunk_collection_id,
      manifestHash:      row.manifest_hash,
      size,
      chunks,
    };
  }
}
