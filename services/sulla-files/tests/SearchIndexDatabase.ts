// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Shared fixture for the search/index repository specs: a throwaway schema with every real
// Files migration applied (triggers included), plus small seeding helpers. It applies the
// migrations itself instead of calling db.ts `migrate`, which terminates other migrators by
// application name and would kill a spec file running in parallel.
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

export interface SeededFile { fileId:string; versionId:string; collectionId:string }

export class SearchIndexDatabase {
  readonly schema = `files_search_spec_${ randomUUID().replaceAll('-', '') }`;
  private admin?:pg.Pool;
  pool!:pg.Pool;

  constructor(private readonly url:string, private readonly poolMax = 4) {}

  async create():Promise<void> {
    this.admin = new pg.Pool({ connectionString: this.url, max: 1 });
    await this.admin.query(`CREATE SCHEMA ${ this.schema }`);
    this.pool = new pg.Pool({ connectionString: this.url, max: this.poolMax, options: `-csearch_path=${ this.schema },public` });
    this.pool.on('error', () => undefined);
    const dir = new URL('../migrations/', import.meta.url);
    const files = readdirSync(dir).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
    const client = await this.pool.connect();
    try {
      await client.query('CREATE TABLE files_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
      for (const name of files) {
        await client.query('BEGIN');
        await client.query(readFileSync(new URL(name, dir), 'utf8'));
        await client.query('INSERT INTO files_schema_migrations(version) VALUES($1)', [name]);
        await client.query('COMMIT');
      }
    } finally { client.release() }
  }

  async drop():Promise<void> {
    await this.pool?.end();
    await this.admin?.query(`DROP SCHEMA IF EXISTS ${ this.schema } CASCADE`);
    await this.admin?.end();
  }

  async vectorsAvailable():Promise<boolean> {
    return Boolean((await this.pool.query("SELECT to_regclass('file_search_vectors') IS NOT NULL ok")).rows[0].ok);
  }

  async collection(systemArea:string | null = null, owner = 'search-user'):Promise<string> {
    const id = randomUUID();
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,compatibility_state,explorer_path,system_area)
      VALUES($1,$2,'Spec','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,'native',$3,$4)`, [id, owner, id, systemArea]);
    return id;
  }

  /** A file with one committed version; the real triggers queue its index job. */
  async file(collectionId:string, path:string, options:{ mime?:string; createdById?:string; manifestHash?:string } = {}):Promise<SeededFile> {
    const fileId = (await this.pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime)
      VALUES($1,$2,'user',$3,$4) RETURNING id`, [collectionId, path, options.createdById ?? 'search-user', options.mime ?? 'text/plain'])).rows[0].id;
    const versionId = await this.version(fileId, collectionId, options.manifestHash);
    return { fileId, versionId, collectionId };
  }

  /** Adds a version and makes it current (as every writer does). */
  async version(fileId:string, collectionId:string, manifestHash?:string):Promise<string> {
    const versionId = (await this.pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id,manifest_hash)
      VALUES($1,$2,10,'user','search-user','spec-device',$3) RETURNING id`, [fileId, collectionId, manifestHash ?? null])).rows[0].id;
    await this.pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    return versionId;
  }

  async chunk(fileId:string, versionId:string, ordinal:number, content:string, embedding?:number[]):Promise<string> {
    return (await this.pool.query(`INSERT INTO file_search_chunks(file_id,version_id,ordinal,content,embedding_json) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [fileId, versionId, ordinal, content, embedding ? JSON.stringify(embedding) : null])).rows[0].id;
  }

  async job(versionId:string):Promise<any> {
    return (await this.pool.query('SELECT * FROM file_index_jobs WHERE version_id=$1', [versionId])).rows[0];
  }

  async fileRow(fileId:string):Promise<any> {
    return (await this.pool.query('SELECT * FROM files WHERE id=$1', [fileId])).rows[0];
  }
}
