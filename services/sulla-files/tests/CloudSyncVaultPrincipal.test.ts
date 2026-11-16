// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Same stale-owner bug as the FUSE root 404 (#2485), in cloud sync: CloudSyncService is built while
// config.userId is still the "desktop-user" sentinel, then Vault unlock runs VaultPrincipalAdoption,
// which re-owns every collection and sets config.userId to the Vault principal. The service had copied
// config.userId into its pull actor at construction, so every folder (and file version) pulled from
// Sulla Cloud after unlock was stamped with the sentinel, not the principal that now owns the store.
// Real service construction, real adoption, real migrated Postgres, the puller's real folder write.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CloudSyncService } from '../src/cloudSync/service.js';
import { Store } from '../src/store.js';
import { VaultPrincipalAdoption } from '../src/vaultPrincipal.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

import type { PullRepository } from '../src/cloudSync/pull.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

const PRINCIPAL = 'vault-principal-imac';
const SENTINEL = 'desktop-user';

describe.skipIf(!databaseUrl)('Cloud sync after Vault principal adoption (real service, real Postgres)', () => {
  const fixture = new FilesRoutesFixture(SENTINEL);
  let pull:PullRepository;

  beforeAll(async() => {
    await fixture.start();
    // Built exactly as FilesProcess builds it on a desktop: before Vault unlocks, owned by the sentinel.
    const broker = { execute: async() => { throw new Error('no Cloud in this spec') } };
    const service = new CloudSyncService(fixture.pool, fixture.config, fixture.config.keyring, new Store(fixture.config.chunkRoot), broker);
    // The puller's own store, as the service composed it (no network: the spec feeds it one remote folder).
    pull = (service as unknown as { repositories:{ pull:PullRepository } }).repositories.pull;
    // Vault unlock: the real adoption re-owns the collections and moves config.userId.
    await new VaultPrincipalAdoption(fixture.pool).adopt(fixture.config, PRINCIPAL);
    expect(fixture.config.userId).toBe(PRINCIPAL);
  }, 30_000);
  afterAll(() => fixture.stop());

  it('stamps a folder pulled after unlock, and the parents it creates, with the Vault principal', async() => {
    // risk: data accuracy/ownership — pulled folders attributed to the sentinel belong to no one after adoption.
    const fileId = randomUUID(); const versionId = randomUUID();
    await pull.applyRemoteFolderVersion({
      collectionId: fixture.collectionId,
      remote: { fileId, versionId, parentVersionId: null, deleted: false, manifest: {} as never, chunkIds: [], seq: 1, deviceId: 'other-device', createdAt: null },
      manifest: { v: 1, path: 'Pulled/Deep', kind: 'folder', mime: 'inode/directory', size: 0, mtime: new Date(0).toISOString(), sha256: '', chunks: [], deleted: false, parentVersionId: null },
      content: null,
      remoteDeviceLabel: 'other-device',
    });
    const rows = (await fixture.pool.query("SELECT path, created_by_id, id::text AS id FROM file_folders WHERE collection_id=$1 AND path IN ('Pulled','Pulled/Deep') ORDER BY path", [fixture.collectionId])).rows;
    expect(rows.map(row => [row.path, row.created_by_id])).toEqual([['Pulled', PRINCIPAL], ['Pulled/Deep', PRINCIPAL]]);
    // The pulled folder keeps its Cloud identity.
    expect(rows[1].id).toBe(fileId);
  });
});
