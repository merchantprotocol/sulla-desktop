// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Envelope } from '../crypto.js';
import type pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'>;

export interface WrappedCollectionKeyRow { collection_id:string; data_key:Envelope; dedup_key:Envelope }
export interface LegacyMigrationRow { id:string; data_key:Envelope | null; dedup_key:Envelope | null; key_origin:string | null }
export interface KeyOriginRow { collection_id:string; key_origin:string }
export interface CollectionKeyContextRow {
  collection_id:       string;
  owner_user_id:       string;
  compatibility_state: string;
  key_origin:          string;
  key_version:         number;
  key_epoch:           number;
}
export interface PublishedCollectionStateRow { collection_id:string; key_origin:string; owner_user_id:string; compatibility_state:string }

/**
 * files_collection_keys: the device-master-wrapped data/dedup keys and the key
 * context (origin, version, epoch) of each collection. Every method takes an
 * optional client so transactional callers run on their checked-out client.
 */
export class CollectionKeyRepository {
  constructor(private readonly db:Queryable) {}

  /** Wrapped keys of every published, non-legacy-source collection (unlock verification). */
  async publishedWrappedKeys(client:Queryable = this.db):Promise<WrappedCollectionKeyRow[]> {
    return (await client.query(`SELECT k.collection_id,k.data_key,k.dedup_key FROM files_collection_keys k
          JOIN collections c ON c.id=k.collection_id WHERE c.published=TRUE AND c.legacy_source=FALSE`)).rows;
  }

  /** Native published collections and any key row, locked, for the first-unlock legacy key migration. */
  async lockNativeCollectionsForLegacyMigration(client:Queryable = this.db):Promise<LegacyMigrationRow[]> {
    return (await client.query(`SELECT c.id,k.data_key,k.dedup_key,k.key_origin
          FROM collections c LEFT JOIN files_collection_keys k ON k.collection_id=c.id
          WHERE c.compatibility_state='native' AND c.published=TRUE AND c.legacy_source=FALSE
          ORDER BY c.id FOR UPDATE OF c`)).rows;
  }

  async insertLegacySigningKeys(client:Queryable, collectionId:string, data:Envelope, dedup:Envelope):Promise<void> {
    await client.query("INSERT INTO files_collection_keys(collection_id,data_key,dedup_key,key_origin) VALUES($1,$2,$3,'legacy-signing-v1')", [collectionId, data, dedup]);
  }

  /** New random keys; key_origin takes the table default ('random'). */
  async insertRandomKeys(client:Queryable, collectionId:string, data:Envelope, dedup:Envelope):Promise<void> {
    await client.query('INSERT INTO files_collection_keys(collection_id,data_key,dedup_key) VALUES($1,$2,$3)', [collectionId, data, dedup]);
  }

  async findWrappedKeys(collectionId:string, client:Queryable = this.db):Promise<Pick<WrappedCollectionKeyRow, 'data_key' | 'dedup_key'> | undefined> {
    return (await client.query('SELECT data_key,dedup_key FROM files_collection_keys WHERE collection_id=$1', [collectionId])).rows[0];
  }

  async findKeyOrigin(collectionId:string, client:Queryable = this.db):Promise<string | undefined> {
    const row = (await client.query('SELECT key_origin FROM files_collection_keys WHERE collection_id=$1', [collectionId])).rows[0];
    return row?.key_origin;
  }

  /** Origins of every published, non-legacy-source key row, ordered by collection (device recovery). */
  async publishedKeyOrigins(client:Queryable = this.db):Promise<KeyOriginRow[]> {
    return (await client.query(`SELECT k.collection_id,k.key_origin FROM files_collection_keys k
        JOIN collections c ON c.id=k.collection_id
        WHERE c.published=TRUE AND c.legacy_source=FALSE ORDER BY k.collection_id`)).rows;
  }

  async replaceWrappedKeys(client:Queryable, collectionId:string, data:Envelope, dedup:Envelope):Promise<void> {
    await client.query('UPDATE files_collection_keys SET data_key=$2,dedup_key=$3 WHERE collection_id=$1', [collectionId, data, dedup]);
  }

  /** Current key context of one collection. */
  async findKeyContext(collectionId:string, client:Queryable = this.db):Promise<CollectionKeyContextRow | undefined> {
    return (await client.query(
      `SELECT k.collection_id,c.owner_user_id,c.compatibility_state,k.key_origin,k.key_version,k.key_epoch
         FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
        WHERE k.collection_id=$1`,
      [collectionId],
    )).rows[0] as CollectionKeyContextRow | undefined;
  }

  /** Current key context of one collection, row-locked on both the key and the collection. */
  async lockKeyContext(collectionId:string, client:Queryable = this.db):Promise<CollectionKeyContextRow | undefined> {
    return (await client.query(
      `SELECT k.collection_id,c.owner_user_id,k.key_version,k.key_epoch,k.key_origin,c.compatibility_state
         FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
        WHERE k.collection_id=$1 FOR UPDATE OF k,c`,
      [collectionId],
    )).rows[0] as CollectionKeyContextRow | undefined;
  }

  /** Native published random-key collections owned by `principalId`, ordered by id (custody enrollment). */
  async ownedRandomCollectionIds(principalId:string, client:Queryable = this.db):Promise<string[]> {
    return (await client.query<{ collection_id: string }>(
      `SELECT k.collection_id FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
        WHERE c.owner_user_id=$1 AND c.compatibility_state='native' AND c.published=TRUE AND c.legacy_source=FALSE
          AND k.key_origin='random'
        ORDER BY k.collection_id`,
      [principalId],
    )).rows.map(row => row.collection_id);
  }

  /** Owner and compatibility of every published, non-legacy-source key row, ordered by collection. */
  async publishedCollectionStates(client:Queryable = this.db):Promise<PublishedCollectionStateRow[]> {
    return (await client.query(
      `SELECT k.collection_id,k.key_origin,c.owner_user_id,c.compatibility_state
         FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
        WHERE c.published=TRUE AND c.legacy_source=FALSE ORDER BY k.collection_id`,
    )).rows as PublishedCollectionStateRow[];
  }
}
