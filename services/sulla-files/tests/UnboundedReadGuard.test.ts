// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UnboundedReadGuard } from '../src/UnboundedReadGuard.js';
import { stateHash, type StateEntry } from '../src/cloudSync/envelope.js';
import { streamingStateHash } from '../src/cloudSync/stateHashStream.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * Reviewed reads that are still unbounded (2026-11-14, files-scale S2). Each count is a
 * ceiling: adding another unbounded read to a file fails CI. Lower the number when a
 * read is bounded. Owners: FUSE (S1), automerge/versions (S3), indexer/search (S4),
 * folder batches and migrations (bounded per operation subtree, follow-up).
 */
const ALLOWED:Record<string, number> = {
  // Finder badges: one row per live file of the one requested collection (moved from cloudSync/repository.ts).
  'Repositories/CloudCollectionCatalogRepository.ts': 1,
  'Repositories/CloudFolderCoverageRepository.ts': 1,
  // Legacy server sync push queue (moved from localManager.ts): one device's unpushed journal per pass.
  'Repositories/LegacySyncRepository.ts': 1,
  // Folder move/copy plan lock (moved from localManager.ts): one user-selected folder subtree.
  'Repositories/PathOperationPublishRepository.ts': 1,
  // FUSE mount listing (moved from localManager.ts): one collection's mountable files.
  'Repositories/TrackedFileRepository.ts': 1,
  // Legacy import: converts every legacy version once; counts and provenance checks are one-row aggregates.
  'Repositories/LegacyImportIdentityRepository.ts': 1,
  'Repositories/LegacyImportPublicationRepository.ts': 1,
  'Repositories/LegacyImportReceiptRepository.ts': 1,
  // Shared-folder listing for a public folder link (moved from shares.ts, same read).
  'Repositories/ShareLinkRepository.ts': 1,
  // Child-folder totals: one GROUP BY row per direct child folder of the open folder, never a row per file.
  'Repositories/CollectionFilesFeedRepository.ts': 1,
  // Folder batch subtree reads (move/Trash/restore/purge/undo), bounded per operation subtree.
  'Repositories/FolderSubtreeRepository.ts': 7,
  // Maintenance-only scratch TTL sweep (moved from app.ts).
  'Repositories/ScratchMaintenanceRepository.ts': 1,
  // One principal's stars in one collection (moved from app.ts).
  'Repositories/StarRepository.ts': 1,
  // One collection's trashed files and top-level trashed folders (moved from app.ts).
  'Repositories/TrashListingRepository.ts': 2,
  // Legacy stored folder move: the moved folder's own subtree, locked for update.
  'Repositories/StoredFileOperationRepository.ts': 1,
  // Bounded by the caller's path array: the ancestors of one path being created (moved from storedNamespace.ts).
  'Repositories/StoredNamespaceRepository.ts': 1,
  // One-time Sulla-collection merge and stray-Docs cleanup, moved row by row (moved from sullaCollectionMigration.ts).
  'Repositories/SullaCollectionMigrationRepository.ts': 4,
  // Maintenance-only repair scan; returns only versions whose chunk rows are missing (indexed by 066).
  'Repositories/ChunkMetadataRepairRepository.ts': 1,
  'app.ts': 5,
};

function sources(directory:string):string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(absolute);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [absolute] : [];
  });
}

describe('unbounded reads on large Files tables', () => {
  it('flags whole-collection reads and accepts LIMIT, single-row and EXISTS reads', () => {
    // risk: a whole-collection SELECT loads every file into memory and OOMs the service.
    expect(UnboundedReadGuard.isUnbounded('SELECT file_id,version_id,deleted FROM files_cloud_file_heads WHERE collection_id=$1')).toBe(true);
    expect(UnboundedReadGuard.isUnbounded('SELECT path FROM files WHERE collection_id=$1 AND path>$2 ORDER BY path LIMIT $3')).toBe(false);
    expect(UnboundedReadGuard.isUnbounded('SELECT * FROM files WHERE id=$1')).toBe(false);
    expect(UnboundedReadGuard.isUnbounded('SELECT * FROM collections c WHERE EXISTS(SELECT 1 FROM files f WHERE f.collection_id=c.id)')).toBe(false);
  });

  it('adds no new unbounded SELECT beyond the reviewed allowlist', () => {
    // risk: new code silently reintroduces reads whose memory grows with file count.
    const found:Record<string, number> = {};
    for (const file of sources(root)) {
      const count = UnboundedReadGuard.count(fs.readFileSync(file, 'utf8'));
      if (count) found[path.relative(root, file).split(path.sep).join('/')] = count;
    }
    const over = Object.entries(found).filter(([file, count]) => count > (ALLOWED[file] ?? 0));
    expect(over, 'Bound the new read with LIMIT/keyset cursor, or review it into ALLOWED').toEqual([]);
  });
});

describe('streamed cloud state hash', () => {
  it('matches the in-memory envelope hash while reading heads in small pages', async() => {
    // risk: a different hash rejects every pull/commit (sync integrity) after the streaming change.
    const id = (n:number) => `00000000-0000-4000-8000-${ String(n).padStart(12, '0') }`;
    const heads:StateEntry[] = Array.from({ length: 1000 }, (_, n) => ({ fileId: id(n * 2), versionId: id(n + 5000), deleted: n % 7 === 0 }));
    const overrides:StateEntry[] = [{ fileId: id(10), versionId: id(9999), deleted: true }, { fileId: id(1), versionId: id(8888), deleted: false }, { fileId: id(5000), versionId: id(7777), deleted: false }];
    const projected = new Map(heads.map(entry => [entry.fileId, entry]));
    for (const entry of overrides) projected.set(entry.fileId, entry);
    let largestPage = 0;
    async function* pages() { for (let index = 0; index < heads.length; index += 64) { const page = heads.slice(index, index + 64); largestPage = Math.max(largestPage, page.length); yield page } }
    expect(await streamingStateHash(pages(), overrides)).toBe(await stateHash([...projected.values()]));
    expect(largestPage).toBe(64);
  });
});
