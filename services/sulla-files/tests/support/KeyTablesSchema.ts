// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';

const migration = (name:string) => readFileSync(new URL(`../../migrations/${ name }`, import.meta.url), 'utf8');

/**
 * A throwaway schema holding the collection-key tables exactly as the real
 * migrations create them (006 share links, 007 keychain keys, 011 key bundles,
 * 017 remote key recovery), on top of minimal base tables with the columns those
 * queries read. The schema's search_path is set per connection.
 */
export class KeyTablesSchema {
  readonly name = `files_keys_spec_${ randomUUID().replaceAll('-', '') }`;
  readonly pool:pg.Pool;

  constructor(databaseUrl:string) {
    // search_path rides on every connection: a client destroyed after a failed transaction is replaced
    // by a fresh one, and a session-level SET would leave that one pointing at public.
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${ this.name }` });
  }

  async create():Promise<void> {
    await this.pool.query(`CREATE SCHEMA ${ this.name }`);
    await this.pool.query(`CREATE TABLE collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id text NOT NULL,
      compatibility_state text NOT NULL DEFAULT 'native',published boolean NOT NULL DEFAULT TRUE,legacy_source boolean NOT NULL DEFAULT FALSE,
      updated_at timestamptz NOT NULL DEFAULT NOW())`);
    await this.pool.query('CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL REFERENCES collections(id),path text NOT NULL)');
    await this.pool.query('CREATE TABLE manifests(hash text PRIMARY KEY,chunk_ids jsonb NOT NULL)');
    await this.pool.query('CREATE TABLE file_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),file_id uuid NOT NULL REFERENCES files(id),chunk_collection_id uuid NOT NULL,manifest_hash text)');
    await this.pool.query(migration('006_share_links.sql'));
    await this.pool.query(migration('007_keychain_keys.sql'));
    await this.pool.query(migration('011_key_bundle_recovery.sql'));
    await this.pool.query(migration('017_file_residency.sql'));
  }

  async reset():Promise<void> {
    await this.pool.query('TRUNCATE file_share_links, files_remote_key_recovery, files_collection_key_bundles, files_collection_keys, files_key_state, file_versions, files, collections CASCADE');
  }

  async drop():Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${ this.name } CASCADE`);
    await this.pool.end();
  }

  async collection(owner:string, options:{ compatibility?:string; published?:boolean; legacySource?:boolean } = {}):Promise<string> {
    return (await this.pool.query(
      'INSERT INTO collections(owner_user_id,compatibility_state,published,legacy_source) VALUES($1,$2,$3,$4) RETURNING id::text',
      [owner, options.compatibility ?? 'native', options.published ?? true, options.legacySource ?? false],
    )).rows[0].id;
  }

  /** A share link that satisfies 006's target CHECK: a folder link on a collection, or a file link. */
  async shareLink(id:string, owner:string, target:{ collectionId:string } | { fileId:string }):Promise<void> {
    const isFile = 'fileId' in target;
    await this.pool.query(
      `INSERT INTO file_share_links(id,owner_user_id,target_type,file_id,collection_id,folder_path,display_name,access_mode,served_from)
        VALUES($1,$2,$3,$4,$5,$6,'spec link','view','desktop')`,
      [id, owner, isFile ? 'file' : 'folder', isFile ? target.fileId : null, isFile ? null : target.collectionId, isFile ? null : '/'],
    );
  }
}
