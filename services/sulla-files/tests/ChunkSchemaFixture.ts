// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Shared by the chunk-path Repository specs: a throwaway schema with the real migrations the
// chunk path depends on (001 base tables, 013 upload intents, 049 chunk cache, 066 chunk
// metadata integrity guards), plus the exact files_protected_chunks DDL from 007 and the two
// columns from 024/030 that a streamed-upload commit writes.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

export class ChunkSchemaFixture {
  readonly schema = `files_chunk_spec_${ randomUUID().replaceAll('-', '') }`;
  readonly pool:pg.Pool;

  constructor(url:string) {
    this.pool = new pg.Pool({ connectionString: url, options: `-c search_path=${ this.schema }`, max: 4 });
  }

  static chunkId():string { return randomBytes(32).toString('hex') }

  async create():Promise<void> {
    await this.pool.query(`CREATE SCHEMA ${ this.schema }`);
    // gen_random_uuid() is built in (PG13+); creating pgcrypto per schema would race between specs.
    await this.pool.query(migration('001_sulla_files.sql').replace(/CREATE EXTENSION[^;]*;/, ''));
    await this.pool.query('CREATE TABLE files_protected_chunks (collection_id UUID NOT NULL, chunk_id TEXT NOT NULL, PRIMARY KEY(collection_id,chunk_id))');
    await this.pool.query('ALTER TABLE collections ADD COLUMN IF NOT EXISTS system_area TEXT NULL');
    await this.pool.query("ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS publication_status TEXT CHECK(publication_status IN('draft','published','superseded'))");
    await this.pool.query(migration('013_upload_intents.sql'));
    await this.pool.query(migration('049_chunk_cache.sql'));
    await this.pool.query(migration('066_chunk_metadata_integrity.sql'));
  }

  async drop():Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${ this.schema } CASCADE`);
    await this.pool.end();
  }

  async reset():Promise<void> {
    await this.pool.query('TRUNCATE collections, manifests, chunks, files, file_versions, journal, audit_log, file_upload_intents, files_chunk_cache, files_protected_chunks CASCADE');
  }

  async collection(options:{ keepOnComputer?:boolean } = {}):Promise<string> {
    return (await this.pool.query(`INSERT INTO collections(owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,keep_on_computer)
      VALUES('u1','Spec','knowledge','desktop-only','{}'::jsonb,'{}'::jsonb,$1) RETURNING id`, [options.keepOnComputer ?? false])).rows[0].id;
  }

  async chunk(collectionId:string, id:string, size = 10, storedSize = 100):Promise<void> {
    await this.pool.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0)', [collectionId, id, size, storedSize, `chunks/${ collectionId }/${ id }`]);
  }

  async manifest(chunkIds:string[], totalSize:number):Promise<string> {
    const hash = randomBytes(32).toString('hex');
    await this.pool.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3)', [hash, JSON.stringify(chunkIds), totalSize]);
    return hash;
  }

  /** A file whose current version points at `manifestHash` (the 066 trigger requires its chunk rows). */
  async file(collectionId:string, manifestHash:string, size:number, path = `docs/${ randomUUID() }.txt`):Promise<{ fileId:string; versionId:string }> {
    const fileId = (await this.pool.query("INSERT INTO files(collection_id,path,created_by_type,created_by_id,size) VALUES($1,$2,'user','u1',$3) RETURNING id", [collectionId, path, size])).rows[0].id;
    const versionId = (await this.pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,$4,'user','u1','spec') RETURNING id`, [fileId, collectionId, manifestHash, size])).rows[0].id;
    await this.pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    return { fileId, versionId };
  }
}
