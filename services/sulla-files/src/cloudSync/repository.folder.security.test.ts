// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PgCloudSyncRepository } from './repository.js';
import type { ApplyRemoteInput } from './pull.js';

const COLLECTION = '0b6f0c32-4d1e-4c8a-9a59-2f9f6d1e0a11';

class FolderDb {
  folders = new Map<string, string>();
  files = new Map<string, string>();
  cloud = new Map<string, { path:string | null; deleted:boolean }>();

  async connect() { return { query: this.query.bind(this), release() {} } }
  async query(sql:string, params:any[] = []):Promise<any> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (['BEGIN','COMMIT','ROLLBACK'].includes(text) || text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    if (text.startsWith('SELECT path FROM files_cloud_folders')) {
      const row = this.cloud.get(params[1]);
      return { rows: row ? [{ path: row.path }] : [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith('SELECT path FROM files WHERE')) {
      const prefixes = new Set(params[1] as string[]);
      const path = [...this.files.values()].find(candidate => prefixes.has(candidate));
      return { rows: path ? [{ path }] : [], rowCount: path ? 1 : 0 };
    }
    if (text.startsWith('SELECT id::text AS id FROM file_folders')) {
      const id = this.folders.get(params[1]);
      return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 };
    }
    if (text.startsWith('SELECT 1 FROM files_cloud_folders')) {
      const row = this.cloud.get(params[1]);
      const found = row && !row.deleted;
      return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
    }
    if (text.startsWith('INSERT INTO file_folders(collection_id,path')) {
      if (!this.folders.has(params[1])) this.folders.set(params[1], randomUUID());
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO file_folders(id,collection_id,path')) {
      this.folders.set(params[2], params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('UPDATE file_folders SET id=')) {
      this.folders.set(params[1], params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('UPDATE file_folders SET path=')) {
      this.moveFolders(params[1], params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('UPDATE files SET path=')) {
      this.move(this.files, params[1], params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('DELETE FROM file_folders')) {
      if (this.folders.get(params[1]) === params[2]) this.folders.delete(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO files_cloud_folders')) {
      const deleted = text.includes('$4,TRUE');
      this.cloud.set(params[1], { path: params[3] ?? this.cloud.get(params[1])?.path ?? null, deleted: deleted || Boolean(params[4]) });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('UPDATE files_cloud_folders SET path=')) {
      for (const row of this.cloud.values()) {
        const path = row.path;
        if (typeof path === 'string' && (path === params[1] || path.startsWith(`${ params[1] }/`))) {
          row.path = `${ params[2] }${ path.slice(params[1].length) }`;
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO files_cloud_file_heads')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL: ${ text }`);
  }

  private move(rows:Map<string, string>, from:string, to:string) {
    for (const [key, value] of [...rows]) {
      if (value === from || value.startsWith(`${ from }/`)) rows.set(key, `${ to }${ value.slice(from.length) }`);
    }
  }

  private moveFolders(from:string, to:string) {
    const moving = [...this.folders].filter(([path]) => path === from || path.startsWith(`${ from }/`));
    const movingPaths = new Set(moving.map(([path]) => path));
    const targets = moving.map(([path, id]) => [`${ to }${ path.slice(from.length) }`, id] as const);
    for (const [path] of targets) {
      if (this.folders.has(path) && !movingPaths.has(path)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint file_folders_collection_path_key'), { code:'23505' });
      }
    }
    for (const [path] of moving) this.folders.delete(path);
    for (const [path, id] of targets) this.folders.set(path, id);
  }
}

function input(fileId:string, path:string, deleted=false):ApplyRemoteInput {
  const versionId = randomUUID();
  return {
    collectionId: COLLECTION,
    remote: { fileId, versionId, parentVersionId:null, deleted, seq:1, deviceId:'phone', createdAt:null, manifest:{} as any, chunkIds:[] },
    manifest: { v:1, kind:'folder', path, mime:'application/x-directory', size:0, mtime:new Date(0).toISOString(), sha256:'0'.repeat(64), chunks:[], deleted, parentVersionId:null },
    content:null,
    remoteDeviceLabel:'phone',
  };
}

test('a remotely materialized folder adopts its synthetic parent row identity', async() => {
  const db = new FolderDb();
  const remoteId = randomUUID();
  db.folders.set('Phone', randomUUID());
  await new PgCloudSyncRepository(db as any, { kind:'human', userId:'user', deviceId:'desktop' } as any).applyRemoteFolderVersion(input(remoteId, 'Phone'));
  assert.equal(db.folders.get('Phone'), remoteId);
  assert.deepEqual(db.cloud.get(remoteId), { path:'Phone', deleted:false });
});

test('rename collision retains the other identity and moves nested children to a conflict subtree', async() => {
  const db = new FolderDb();
  const remoteId = randomUUID(), occupiedId = randomUUID(), childId = randomUUID();
  db.folders.set('Old', remoteId); db.folders.set('Old/Child', childId); db.folders.set('Taken', occupiedId);
  db.files.set(randomUUID(), 'Old/Child/note.txt');
  db.cloud.set(remoteId, { path:'Old', deleted:false }); db.cloud.set(childId, { path:'Old/Child', deleted:false });
  db.cloud.set(occupiedId, { path:'Taken', deleted:false });
  await new PgCloudSyncRepository(db as any, { kind:'human', userId:'user', deviceId:'desktop' } as any).applyRemoteFolderVersion(input(remoteId, 'Taken'));
  const moved = db.cloud.get(remoteId)?.path ?? '';
  assert.match(moved, /^Taken \(conflicted copy phone /);
  assert.equal(db.folders.get('Taken'), occupiedId);
  assert.ok([...db.files.values()].includes(`${ moved }/Child/note.txt`));
  assert.equal(db.cloud.get(childId)?.path, `${ moved }/Child`, 'stable child identity follows the renamed subtree');
});

test('deleting one folder identity retains independently versioned nested children', async() => {
  const db = new FolderDb();
  const remoteId = randomUUID(), childId = randomUUID();
  db.folders.set('Parent', remoteId); db.folders.set('Parent/Child', childId);
  db.files.set(randomUUID(), 'Parent/Child/note.txt'); db.cloud.set(remoteId, { path:'Parent', deleted:false });
  await new PgCloudSyncRepository(db as any, { kind:'human', userId:'user', deviceId:'desktop' } as any).applyRemoteFolderVersion(input(remoteId, 'Parent', true));
  assert.equal(db.folders.has('Parent'), false);
  assert.equal(db.folders.has('Parent/Child'), true);
  assert.ok([...db.files.values()].includes('Parent/Child/note.txt'));
});
