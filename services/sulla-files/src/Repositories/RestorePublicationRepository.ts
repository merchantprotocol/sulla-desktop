// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SqlIdentifier } from '../backup/SqlIdentifier.js';

import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

/** Restore serialization, isolated staging databases and the durable publication marker. */
export class RestorePublicationRepository {
  async lock(client:pg.PoolClient, key:string):Promise<void> { await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]) }

  async unlock(client:pg.PoolClient, key:string):Promise<void> { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]) }

  async currentRole(client:Queryable):Promise<{ rolcreatedb: boolean; rolsuper: boolean } | undefined> {
    return ((await client.query('SELECT rolcreatedb,rolsuper FROM pg_roles WHERE rolname=current_user')).rows as { rolcreatedb: boolean; rolsuper: boolean }[])[0];
  }

  async createDatabase(admin:Queryable, name:string):Promise<void> {
    await admin.query(`CREATE DATABASE ${ SqlIdentifier.quote(name) } TEMPLATE template0`);
  }

  async dropDatabase(admin:Queryable, name:string):Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS ${ SqlIdentifier.quote(name) }`);
  }

  async record(client:pg.PoolClient, snapshotId:string, archiveSha256:string):Promise<void> {
    await client.query('INSERT INTO files_restore_publications(snapshot_id,archive_sha256) VALUES($1,$2)', [snapshotId, archiveSha256]);
  }

  /** The archive digest published for this snapshot, or undefined when it was never committed. */
  async publishedArchive(client:Queryable, snapshotId:string):Promise<string | undefined> {
    const result = await client.query('SELECT archive_sha256 FROM files_restore_publications WHERE snapshot_id=$1', [snapshotId]);
    if (!result.rowCount) return undefined;
    return (result.rows as { archive_sha256:string }[])[0].archive_sha256;
  }
}
