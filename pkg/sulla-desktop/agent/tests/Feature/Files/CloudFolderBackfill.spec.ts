// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CloudFolderCoverage } from '../../../../../../services/sulla-files/src/cloudSync/folderCoverage.js';
import { CloudPushOrdering } from '../../../../../../services/sulla-files/src/cloudSync/pushOrdering.js';
import type { PushCandidate } from '../../../../../../services/sulla-files/src/cloudSync/repository.js';
import { migrate } from '../../../../../../services/sulla-files/src/db.js';
import { applyDatabaseFileOperations } from '../../../../../../services/sulla-files/src/fileOperations.js';
import { PgCloudFolderCoverageStore } from '../../../../../../services/sulla-files/src/Repositories/CloudFolderCoverageRepository.js';
import { PgCloudPushCandidateRepository } from '../../../../../../services/sulla-files/src/Repositories/CloudPushCandidateRepository.js';

// Real sulla-files migrations on real Postgres: the bug lives in the SQL that chooses what
// to upload. Folders created before migration 057 never entered files_folder_journal, so
// Cloud never received them and their children pointed at parents Cloud did not hold.

const USER_ID = 'cloud-backfill-user';
const ACTOR = { userId: USER_ID, deviceId: 'device-1', kind: 'server-session' } as any;

interface FolderRow { id:string; path:string; namespace_version_id:string; namespace_parent_version_id:string | null }

class CloudFolderFixture {
  private readonly schema = `cloud_backfill_${ randomUUID().replaceAll('-', '') }`;
  private readonly admin:Pool;
  pool!:Pool;
  candidates!:PgCloudPushCandidateRepository;
  coverageStore!:PgCloudFolderCoverageStore;
  ordering!:CloudPushOrdering;
  readonly logs:string[] = [];

  constructor(private readonly url:string) { this.admin = new Pool({ connectionString: url }) }

  async initialize():Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new Pool({ connectionString: this.url, options: `-csearch_path=${ this.schema },public` });
    await migrate(this.pool);
    this.candidates = new PgCloudPushCandidateRepository(this.pool);
    this.coverageStore = new PgCloudFolderCoverageStore(this.pool, this.candidates);
    this.ordering = new CloudPushOrdering(this.candidates);
  }

  coverage():CloudFolderCoverage { return new CloudFolderCoverage(this.coverageStore, line => this.logs.push(line)) }

  async dispose():Promise<void> {
    await this.pool?.end();
    await this.admin.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`);
    await this.admin.end();
  }

  async collection():Promise<string> {
    const id = randomUUID();
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source)
      VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE)`, [id, USER_ID]);
    await this.pool.query("INSERT INTO file_sync_cursors(collection_id,device_id) VALUES($1,'cloud')", [id]);
    return id;
  }

  async folder(collectionId:string, path:string):Promise<string> {
    return (await this.pool.query("INSERT INTO file_folders(collection_id,path,created_by_type,created_by_id) VALUES($1,$2,'user',$3) RETURNING id::text AS id",
      [collectionId, path, USER_ID])).rows[0].id;
  }

  /** The state migration 057 left behind: folders that exist locally but never entered the folder journal. */
  async forgetFolderJournal(collectionId:string):Promise<void> {
    await this.pool.query('DELETE FROM files_folder_journal WHERE collection_id=$1', [collectionId]);
  }

  async file(collectionId:string, path:string):Promise<{ fileId:string; versionId:string }> {
    const fileId = (await this.pool.query("INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,'user',$3,'text/plain',0) RETURNING id::text AS id",
      [collectionId, path, USER_ID])).rows[0].id;
    const versionId = (await this.pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id)
      VALUES($1,$2,NULL,0,FALSE,'user',$3,'test','device-1') RETURNING id::text AS id`, [fileId, collectionId, USER_ID])).rows[0].id;
    await this.pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    await this.pool.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [collectionId, fileId, versionId]);
    return { fileId, versionId };
  }

  async folders(collectionId:string):Promise<FolderRow[]> {
    return (await this.pool.query(`SELECT id::text AS id,path,namespace_version_id::text AS namespace_version_id,namespace_parent_version_id::text AS namespace_parent_version_id
      FROM file_folders WHERE collection_id=$1 ORDER BY path`, [collectionId])).rows;
  }

  async folderJournal(collectionId:string):Promise<Array<{ folder_id:string; version_id:string; op:string }>> {
    return (await this.pool.query(`SELECT folder_id::text AS folder_id,version_id::text AS version_id,op FROM files_folder_journal
      WHERE collection_id=$1 ORDER BY seq`, [collectionId])).rows;
  }

  async cursor(collectionId:string):Promise<number> {
    return Number((await this.pool.query("SELECT last_push_seq FROM file_sync_cursors WHERE collection_id=$1 AND device_id='cloud'", [collectionId])).rows[0].last_push_seq);
  }

  /** What finishCommit records once Cloud accepts a version (cursor advances to its journalSeq, never backwards). */
  async commit(collectionId:string, candidate:PushCandidate):Promise<void> {
    if (candidate.namespace?.kind === 'folder') {
      await this.pool.query('INSERT INTO files_cloud_folder_versions(version_id,collection_id,folder_id,pushed_seq) VALUES($1,$2,$3,1)', [candidate.versionId, collectionId, candidate.fileId]);
    } else {
      await this.pool.query('INSERT INTO files_cloud_versions(version_id,collection_id,file_id,pushed_seq) VALUES($1,$2,$3,1)', [candidate.versionId, collectionId, candidate.fileId]);
    }
    await this.pool.query("UPDATE file_sync_cursors SET last_push_seq=GREATEST(last_push_seq,$2) WHERE collection_id=$1 AND device_id='cloud'", [collectionId, candidate.journalSeq]);
  }

  /** Drives the real ordering gate exactly like CloudPusher.stage + finishCommit, returning the upload order. */
  async drain(collectionId:string, limit = 20):Promise<PushCandidate[]> {
    const order:PushCandidate[] = [];
    for (let index = 0; index < limit; index++) {
      const next = await this.ordering.next(collectionId, await this.cursor(collectionId));
      if (!next) break;
      order.push(next);
      await this.commit(collectionId, next);
    }
    return order;
  }
}

const databaseUrl = process.env.SULLA_TEST_DATABASE_URL ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('Cloud folder backfill and parent-first upload', () => {
  const fixture = new CloudFolderFixture(databaseUrl);
  beforeAll(() => fixture.initialize(), 60_000);
  afterAll(() => fixture.dispose());

  it('backfills historic folders with no journal rows parent-first, then uploads them before their children', async() => {
    // risk: data integrity — Cloud must receive every folder level, or web and other devices see empty/orphaned folders.
    const collectionId = await fixture.collection();
    await fixture.folder(collectionId, 'A/B/C'); // deepest first: insertion order must not decide upload order
    await fixture.folder(collectionId, 'A/B');
    await fixture.folder(collectionId, 'A');
    await fixture.file(collectionId, 'A/B/C/c.md');
    await fixture.forgetFolderJournal(collectionId);
    const before = await fixture.folders(collectionId);

    const { preview, journaled } = await fixture.coverage().previewAndBackfill([collectionId]);
    expect(preview).toEqual({ collections: 1, liveFolders: 3, foldersMissingFromCloud: 3, childrenOfUncommittedParents: 3 });
    expect(journaled).toBe(3);
    const ids = new Map(before.map(row => [row.path, row]));
    expect(await fixture.folderJournal(collectionId)).toEqual(['A', 'A/B', 'A/B/C'].map(path => ({
      folder_id: ids.get(path)!.id, version_id: ids.get(path)!.namespace_version_id, op: 'create',
    })));

    const order = await fixture.drain(collectionId);
    expect(order.map(item => item.path)).toEqual(['A', 'A/B', 'A/B/C', 'A/B/C/c.md']);
    // Every manifest names the parent identity Cloud already committed; nothing is flattened to root.
    expect(order.map(item => item.namespace?.parentFolderId ?? null)).toEqual([null, ids.get('A')!.id, ids.get('A/B')!.id, ids.get('A/B/C')!.id]);
    expect(order.slice(0, 3).map(item => item.namespace?.operation)).toEqual(['create', 'create', 'create']);
  });

  it('is idempotent and never changes local folder ids, paths or namespace versions', async() => {
    // risk: data integrity — owner rule: repair is additive; local ids/paths/history are never rewritten.
    const collectionId = await fixture.collection();
    await fixture.folder(collectionId, 'Docs');
    await fixture.folder(collectionId, 'Docs/2024');
    await fixture.forgetFolderJournal(collectionId);
    const before = await fixture.folders(collectionId);

    expect(await fixture.coverageStore.journalMissingFolders(collectionId)).toBe(2);
    expect(await fixture.coverageStore.journalMissingFolders(collectionId)).toBe(0);
    await fixture.coverage().previewAndBackfill([collectionId]);
    expect(await fixture.folderJournal(collectionId)).toHaveLength(2);
    expect(await fixture.folders(collectionId)).toEqual(before);
  });

  it('holds a child until its never-journaled parent folders commit, without advancing the cursor past it', async() => {
    // risk: data integrity — a manifest must never reference a parentFolderId Cloud has not committed.
    const collectionId = await fixture.collection();
    await fixture.folder(collectionId, 'P');
    await fixture.folder(collectionId, 'P/Q');
    await fixture.forgetFolderJournal(collectionId); // no backfill run: the gate alone must order parents first
    const child = await fixture.file(collectionId, 'P/Q/q.md');
    const folders = new Map((await fixture.folders(collectionId)).map(row => [row.path, row.id]));

    const first = await fixture.ordering.next(collectionId, 0);
    expect(first).toMatchObject({ fileId: folders.get('P'), path: 'P', journalSeq: 0 });
    await fixture.commit(collectionId, first!);
    expect(await fixture.cursor(collectionId)).toBe(0); // the waiting child stays ahead of the cursor

    const second = await fixture.ordering.next(collectionId, 0);
    expect(second).toMatchObject({ fileId: folders.get('P/Q'), path: 'P/Q', journalSeq: 0 });
    expect(second!.namespace?.parentFolderId).toBe(folders.get('P'));
    await fixture.commit(collectionId, second!);

    const third = await fixture.ordering.next(collectionId, 0);
    expect(third).toMatchObject({ fileId: child.fileId, versionId: child.versionId });
    expect(third!.namespace?.parentFolderId).toBe(folders.get('P/Q'));
  });

  it('holds a nested file whose parent folder is unknown instead of publishing it at the root', async() => {
    // risk: data integrity — an unknown parent must never silently become the collection root.
    const collectionId = await fixture.collection();
    const orphan = await fixture.file(collectionId, 'Ghost/y.md'); // legacy row: no folder identity for Ghost

    expect(await fixture.ordering.next(collectionId, 0)).toBeNull();
    const hold = (await fixture.pool.query('SELECT reason,kind FROM files_cloud_namespace_holds WHERE version_id=$1', [orphan.versionId])).rows[0];
    expect(hold).toEqual({ reason: 'parent-unavailable', kind: 'file' });

    // Once the parent exists and the hold is due, the parent uploads first and then the file, with its real parent.
    const ghostId = await fixture.folder(collectionId, 'Ghost');
    await fixture.pool.query("UPDATE files_cloud_namespace_holds SET retry_at=NOW()-INTERVAL '1 second' WHERE version_id=$1", [orphan.versionId]);
    const order = await fixture.drain(collectionId);
    expect(order.map(item => item.path)).toEqual(['Ghost', 'Ghost/y.md']);
    expect(order[1].namespace?.parentFolderId).toBe(ghostId);
  });

  it('pushes a rename of an already-uploaded file as a new namespace version', async() => {
    // risk: data integrity — a rename-only change was skipped because its version was already in Cloud.
    const collectionId = await fixture.collection();
    const folderId = await fixture.folder(collectionId, 'Notes');
    const file = await fixture.file(collectionId, 'Notes/old.md');
    expect((await fixture.drain(collectionId)).map(item => item.path)).toEqual(['Notes', 'Notes/old.md']);
    expect(await fixture.ordering.next(collectionId, await fixture.cursor(collectionId))).toBeNull();

    const row = (await fixture.pool.query('SELECT * FROM files WHERE id=$1', [file.fileId])).rows[0];
    const [moved] = await applyDatabaseFileOperations(fixture.pool, 'move', [{ file: row, targetPath: 'Notes/new.md' }], ACTOR);

    const next = await fixture.ordering.next(collectionId, await fixture.cursor(collectionId));
    expect(next).toMatchObject({ fileId: file.fileId, parentVersionId: file.versionId, path: 'Notes/new.md' });
    expect(next!.versionId).not.toBe(file.versionId);
    expect(next!.namespace).toMatchObject({ name: 'new.md', parentFolderId: folderId, operation: 'metadata' });
    expect(moved.current_version_id).toBe(next!.versionId);
    // The original version stays in history; only a successor was added.
    const history = (await fixture.pool.query('SELECT id::text AS id FROM file_versions WHERE file_id=$1 ORDER BY created_at,id', [file.fileId])).rows.map(r => r.id);
    expect(history).toContain(file.versionId);
    expect(history).toHaveLength(2);
  });

  it('moves a folder as one folder version without re-pushing every file inside it', async() => {
    // risk: performance/integrity — children keep their parent identity, so only the moved folder changes in Cloud.
    const collectionId = await fixture.collection();
    const folderId = await fixture.folder(collectionId, 'Inbox');
    const file = await fixture.file(collectionId, 'Inbox/a.md');
    await fixture.drain(collectionId);

    const row = (await fixture.pool.query('SELECT * FROM files WHERE id=$1', [file.fileId])).rows[0];
    await applyDatabaseFileOperations(fixture.pool, 'move', [{ file: row, targetPath: 'Archive/a.md' }], ACTOR,
      [{ collectionId, sourcePath: 'Inbox', targetPath: 'Archive' }]);

    const order = await fixture.drain(collectionId);
    expect(order.map(item => [item.fileId, item.path])).toEqual([[folderId, 'Archive']]);
    expect((await fixture.pool.query('SELECT current_version_id::text AS v FROM files WHERE id=$1', [file.fileId])).rows[0].v).toBe(file.versionId);
  });
});
