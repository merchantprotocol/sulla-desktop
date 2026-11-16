// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Regression for the iMac release blocker (Desktop main 22f0e63, sulla-files sha-bb543a78): the Files
// app is built while config.userId is still the "desktop-user" sentinel, then Vault unlock runs
// VaultPrincipalAdoption, which re-owns every collection to the Vault principal and sets
// config.userId to it. FuseReadRoutes/FuseTreeSnapshotCache had copied the sentinel string at build
// time, so the FUSE adapter's first root listing (GET /v1/fuse/directory?path=&limit=500, no
// collectionId) answered 404 "Files collection not found" and the mount never stayed up.
// Real app, real Postgres, the adapter's exact request shape.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { VaultPrincipalAdoption } from '../src/vaultPrincipal.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

const PRINCIPAL = 'vault-principal-imac';

describe.skipIf(!databaseUrl)('Files mount after Vault principal adoption (real app, real Postgres)', () => {
  // The app starts exactly as on a desktop: owned by the sentinel, adapter token sub = sentinel.
  const fixture = new FilesRoutesFixture('desktop-user');
  let fileId = '';

  beforeAll(async() => {
    await fixture.start();
    fileId = await fixture.createFile('Stress/one.txt');
    await fixture.createFile('top.txt');
    // Warm the tree cache under the sentinel owner so a stale per-owner snapshot would show.
    expect((await fixture.request('/v1/fuse/tree')).body.rootCollectionId).toBe(fixture.collectionId);
    // Vault unlock: the real adoption re-owns the collections and moves config.userId.
    await new VaultPrincipalAdoption(fixture.pool).adopt(fixture.config, PRINCIPAL);
    expect(fixture.config.userId).toBe(PRINCIPAL);
    expect((await fixture.pool.query('SELECT DISTINCT owner_user_id FROM collections')).rows).toEqual([{ owner_user_id: PRINCIPAL }]);
  }, 30_000);
  afterAll(() => fixture.stop());
  afterEach(() => { vi.restoreAllMocks() });

  it('lists the home root for the adapter\'s collection-less request', async() => {
    // risk: availability/data access — the adapter's first readdir of / must find the home collection, or the mount dies.
    const root = await fixture.request('/v1/fuse/directory?path=&limit=500');
    expect(root.status).toBe(200);
    expect(root.body.rootCollectionId).toBe(fixture.collectionId);
    expect(root.body.entries.map((entry:any) => [entry.kind, entry.path])).toEqual([['directory', 'Stress'], ['file', 'top.txt']]);
  });

  it('resolves a root entry without a collection id', async() => {
    // risk: availability — lookup of a top-level name before the root listing must find the home collection too.
    expect(await fixture.request('/v1/fuse/entry?path=Stress%2Fone.txt')).toMatchObject({ status: 200, body: { kind: 'file', id: fileId, collection_id: fixture.collectionId } });
  });

  it('serves the home tree for the adopted principal, not the sentinel\'s cached snapshot', async() => {
    // risk: data accuracy — a tree built for the old owner would show an empty mount after unlock.
    const tree = await fixture.request('/v1/fuse/tree');
    expect(tree.status).toBe(200);
    expect(tree.body.rootCollectionId).toBe(fixture.collectionId);
    expect(tree.body.files.map((row:any) => row.path)).toEqual(expect.arrayContaining(['Stress/one.txt', 'top.txt']));
  });

  it('logs a refused collection lookup at warning level with the route, collection and reason', async() => {
    // risk: operability — the iMac 404 left no trace in the Files log; a refusal must say why.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await fixture.request(`/v1/fuse/directory?collectionId=${ missing }&path=&limit=500`)).status).toBe(404);
    const line = warn.mock.calls.map(call => call.join(' ')).find(text => text.includes('fuse-lookup-refused'));
    expect(line).toBeDefined();
    expect(line).toContain('/v1/fuse/directory');
    expect(line).toContain(missing);
    expect(line).toContain('collection not found');
  });
});
