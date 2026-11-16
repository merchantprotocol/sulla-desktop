// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readdir } from 'node:fs/promises';

import { decryptAndVerifyChunk, maxEncryptedChunkBytes } from './crypto.js';
import type { FilesKeyring } from './keyring.js';
import type { Store } from './store.js';
import type pg from 'pg';

const CHUNK_BYTES = 4 * 1024 * 1024;

export interface ChunkRepairItem { collectionId:string; id:string; size:number; storedSize:number; refcount:number; location:string }
export interface ChunkRepairReport { dryRun:boolean; missingMetadata:ChunkRepairItem[]; restored:ChunkRepairItem[]; unverifiable:{collectionId:string;id:string;reason:string}[]; temporaryFiles:string[] }

/** Authenticated, metadata-only repair. Chunk files are read but never modified. */
export class ChunkMetadataReconciler {
  constructor(private readonly db:pg.Pool, private readonly store:Store, private readonly keyring:FilesKeyring) {}

  async run(options:{apply?:boolean} = {}):Promise<ChunkRepairReport> {
    const dryRun = options.apply !== true;
    const refs = await this.db.query(`SELECT DISTINCT v.chunk_collection_id::text collection_id,x.id,
        m.total_size, x.ordinality::int position, cardinality(ARRAY(SELECT jsonb_array_elements_text(m.chunk_ids)))::int chunk_count
      FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
      CROSS JOIN LATERAL jsonb_array_elements_text(m.chunk_ids) WITH ORDINALITY x(id,ordinality)
      LEFT JOIN chunks c ON c.collection_id=v.chunk_collection_id AND c.id=x.id
      WHERE c.id IS NULL AND m.chunk_ids IS NOT NULL ORDER BY 1,2`);
    const sizes = new Map<string, {collectionId:string;id:string;size:number}>();
    const conflictingSizes = new Set<string>();
    const unverifiable:ChunkRepairReport['unverifiable'] = [];
    for (const row of refs.rows) {
      const collectionId = String(row.collection_id), id = String(row.id);
      const count = Number(row.chunk_count), index = Number(row.position) - 1, total = Number(row.total_size);
      const expected = index < count - 1 ? CHUNK_BYTES : total - CHUNK_BYTES * (count - 1);
      const key = `${collectionId}:${id}`;
      if (!Number.isSafeInteger(expected) || expected <= 0 || expected > CHUNK_BYTES) {
        unverifiable.push({ collectionId, id, reason: 'manifest has invalid chunk sizing' }); conflictingSizes.add(key); sizes.delete(key); continue;
      }
      const prior = sizes.get(key);
      if (prior && prior.size !== expected) {
        unverifiable.push({ collectionId, id, reason: 'deduplicated chunk has conflicting inferred plaintext sizes' });
        sizes.delete(key); conflictingSizes.add(key); continue;
      }
      if (!conflictingSizes.has(key)) sizes.set(key, { collectionId, id, size: expected });
    }
    const verified:ChunkRepairItem[] = [];
    for (const candidate of sizes.values()) {
      try {
        const keys = await this.keyring.keys(candidate.collectionId);
        const storedSize = await this.store.storedSize(candidate.collectionId, candidate.id);
        if (storedSize === undefined || storedSize < 1 || storedSize > maxEncryptedChunkBytes(candidate.size)) throw new Error('chunk file is absent or outside encrypted size bounds');
        const envelope = await this.store.getBounded(candidate.collectionId, candidate.id, maxEncryptedChunkBytes(candidate.size), storedSize);
        await decryptAndVerifyChunk(envelope, keys.data, keys.dedup, candidate.id, candidate.size);
        verified.push({ ...candidate, storedSize, refcount: 0, location: `chunks/${candidate.collectionId}/${candidate.id}` });
      } catch (error) {
        unverifiable.push({ collectionId:candidate.collectionId, id:candidate.id, reason:String((error as Error)?.message ?? error) });
      }
    }
    const missingMetadata = verified.map(item => ({ ...item }));
    const restored:ChunkRepairItem[] = [];
    if (!dryRun && verified.length) {
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
        for (const item of verified) {
          const nowExists = await client.query('SELECT 1 FROM chunks WHERE collection_id=$1 AND id=$2', [item.collectionId,item.id]);
          if (nowExists.rowCount) continue;
          const refsNow = Number((await client.query(`SELECT COUNT(DISTINCT v.id)::int refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
            WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`, [item.collectionId,item.id])).rows[0]?.refs ?? 0);
          const inserted = await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(collection_id,id) DO NOTHING RETURNING id`,
          [item.collectionId,item.id,item.size,item.storedSize,item.location,refsNow]);
          if (inserted.rowCount) restored.push({ ...item, refcount:refsNow });
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    }
    return { dryRun, missingMetadata, restored, unverifiable, temporaryFiles:await this.temporaryFiles() };
  }

  private async temporaryFiles():Promise<string[]> {
    const found:string[] = [];
    for (const collection of await readdir(this.store.rootPath, { withFileTypes:true }).catch(() => [])) {
      if (!collection.isDirectory()) continue;
      const collectionPath = `${this.store.rootPath}/${collection.name}`;
      for (const prefix of await readdir(collectionPath, { withFileTypes:true }).catch(() => [])) {
        if (!prefix.isDirectory()) continue;
        const prefixPath = `${collectionPath}/${prefix.name}`;
        for (const entry of await readdir(prefixPath, { withFileTypes:true }).catch(() => [])) {
          if (entry.isFile() && entry.name.includes('.tmp-')) found.push(`${collection.name}/${prefix.name}/${entry.name}`);
        }
      }
    }
    return found.sort();
  }
}
