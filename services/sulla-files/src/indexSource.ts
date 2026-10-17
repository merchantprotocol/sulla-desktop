import { assertUnprotectedFile, isProtectedPath, protectedPathError } from './protectedFiles.js';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decryptChunk } from './crypto.js';
import { Store } from './store.js';

import type { Config } from './config.js';
import type pg from 'pg';

export function desktopIndexSource(filesRoot:string) { return (file:any) => { if (isProtectedPath(file.path)) throw protectedPathError(); return Promise.resolve({ path: join(filesRoot, file.path) }); } }

export function storedIndexSource(db:pg.Pool, config:Config) {
  const store = new Store(config.chunkRoot); const tempRoot = join(config.dataRoot, 'index-tmp');
  return async(file:any) => {
    await assertUnprotectedFile(db, file);
    const row = (await db.query(`SELECT v.chunk_collection_id,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1`, [file.current_version_id])).rows[0];
    if (!row) throw new Error('Index source version has no manifest');
    const key = (await config.keyring!.keys(row.chunk_collection_id)).data;
    const parts:Buffer[] = [];
    for (const id of row.chunk_ids) parts.push(Buffer.from(await decryptChunk(await store.get(row.chunk_collection_id, id), key, id)));
    await mkdir(tempRoot, { recursive: true, mode: 0o700 }); const path = join(tempRoot, randomUUID()); await writeFile(path, Buffer.concat(parts), { mode: 0o600 });
    return { path, cleanup: async() => { await unlink(path).catch(() => undefined) } };
  };
}
