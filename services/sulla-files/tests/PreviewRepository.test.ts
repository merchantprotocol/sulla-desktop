// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Content/preview lookups and the indexer's source lookups against real Postgres with every Files
// migration applied (including the 066 chunk-integrity guard). Point SULLA_FILES_TEST_DATABASE_URL
// at a throwaway database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IndexSourceRepository } from '../src/Repositories/IndexSourceRepository.js';
import { PreviewRepository } from '../src/Repositories/PreviewRepository.js';
import { databaseUrl, SearchIndexDatabase } from './SearchIndexDatabase.js';

describe.skipIf(!databaseUrl)('preview and index source repositories (real Postgres)', () => {
  const database = new SearchIndexDatabase(databaseUrl ?? '');
  let previews:PreviewRepository;
  let sources:IndexSourceRepository;
  let collectionId = '';

  beforeAll(async() => {
    await database.create();
    previews = new PreviewRepository(database.pool);
    sources = new IndexSourceRepository(database.pool);
  });
  afterAll(async() => { await database.drop() });
  beforeEach(async() => { collectionId = await database.collection() });

  /** A manifest over two real chunk rows (the 066 guard rejects versions that reference missing chunks). */
  async function manifest(totalSize:number):Promise<string> {
    const hash = `spec-${ randomUUID() }`;
    for (const id of ['chunk-a', 'chunk-b']) {
      await database.pool.query("INSERT INTO chunks(collection_id,id,size,stored_size,location) VALUES($1,$2,5,5,'local') ON CONFLICT DO NOTHING", [collectionId, id]);
    }
    await database.pool.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3)', [hash, JSON.stringify(['chunk-a', 'chunk-b']), totalSize]);
    return hash;
  }

  // risk: serving the wrong bytes — content resolves the requested version, or the current one by default.
  it('resolves the current or the requested version with its chunk list', async() => {
    const first = await database.file(collectionId, 'photo.png', { mime: 'image/png', manifestHash: await manifest(10) });
    const secondVersion = await database.version(first.fileId, collectionId, await manifest(10));

    expect(await previews.findVersionContent(first.fileId)).toEqual({ id: first.fileId, path: 'photo.png', mime: 'image/png', version_id: secondVersion, chunk_collection_id: collectionId, chunk_ids: ['chunk-a', 'chunk-b'] });
    expect((await previews.findVersionContent(first.fileId, first.versionId))?.version_id).toBe(first.versionId);
  });

  // risk: deleted versions or another file's version leak through a crafted versionId.
  it('refuses deleted versions and versions of other files', async() => {
    const file = await database.file(collectionId, 'a.txt');
    const otherFile = await database.file(collectionId, 'b.txt');
    const deleted = (await database.pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id,deleted)
      VALUES($1,$2,0,'user','search-user','spec-device',TRUE) RETURNING id`, [file.fileId, collectionId])).rows[0].id;
    expect(await previews.findVersionContent(file.fileId, deleted)).toBeUndefined();
    expect(await previews.findVersionContent(file.fileId, otherFile.versionId)).toBeUndefined();
    expect(await previews.findVersionContent(randomUUID())).toBeUndefined();
  });

  // risk: a stale thumbnail path survives regeneration — saving upserts the version's cached preview.
  it('caches one thumbnail per version and replaces its path on regeneration', async() => {
    const file = await database.file(collectionId, 'clip.mp4', { mime: 'video/mp4' });
    expect(await previews.findPreview(file.versionId, 'thumbnail')).toBeUndefined();
    await previews.saveThumbnail(file.versionId, 'previews/one.jpg');
    await previews.saveThumbnail(file.versionId, `previews/${ file.versionId }.jpg`);
    expect(await previews.findPreview(file.versionId, 'thumbnail')).toEqual({ relative_path: `previews/${ file.versionId }.jpg`, mime: 'image/jpeg' });
    expect((await database.pool.query('SELECT count(*)::int n FROM generated_previews WHERE version_id=$1', [file.versionId])).rows[0].n).toBe(1);
  });

  // risk: the indexer reads a disabled root or the wrong collection's folder.
  it('finds only an enabled Files root for the collection, and a version\'s manifest', async() => {
    expect(await sources.enabledRootPath(collectionId)).toBeUndefined();
    const rootId = `spec-${ randomUUID().slice(0, 8) }`;
    await database.pool.query("INSERT INTO file_roots(id,collection_id,display_name,mount_path,enabled) VALUES($1,$2,'Spec',$3,FALSE)", [rootId, collectionId, `/tmp/${ rootId }`]);
    expect(await sources.enabledRootPath(collectionId)).toBeUndefined();
    await database.pool.query('UPDATE file_roots SET enabled=TRUE WHERE id=$1', [rootId]);
    expect(await sources.enabledRootPath(collectionId)).toBe(`/tmp/${ rootId }`);
    expect(await sources.enabledRootPath(await database.collection())).toBeUndefined();

    const file = await database.file(collectionId, 'doc.pdf', { manifestHash: await manifest(10) });
    expect(await sources.versionManifest(file.versionId)).toEqual({ chunk_collection_id: collectionId, chunk_ids: ['chunk-a', 'chunk-b'], total_size: '10' });
    const empty = await database.file(collectionId, 'empty.txt');
    expect(await sources.versionManifest(empty.versionId)).toBeUndefined();
  });
});
