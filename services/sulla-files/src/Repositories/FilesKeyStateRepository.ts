// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Envelope } from '../crypto.js';
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

/** files_key_state: the single verifier row proving which device master wraps the collection keys. */
export class FilesKeyStateRepository {
  constructor(private readonly db:Queryable) {}

  /** Serializes first-unlock initialization. Must run inside a transaction. */
  async lockState(client:Queryable):Promise<void> {
    await client.query('LOCK TABLE files_key_state IN EXCLUSIVE MODE');
  }

  /** Serializes a master replacement against unlocks and key creation. Must run inside a transaction. */
  async lockStateAndCollectionKeys(client:Queryable):Promise<void> {
    await client.query('LOCK TABLE files_key_state, files_collection_keys IN EXCLUSIVE MODE');
  }

  async findVerifier(client:Queryable = this.db):Promise<Envelope | undefined> {
    return (await client.query('SELECT verifier FROM files_key_state WHERE id=TRUE')).rows[0]?.verifier;
  }

  /** First unlock: fails if a verifier already exists. */
  async insertVerifier(client:Queryable, verifier:Envelope):Promise<void> {
    await client.query('INSERT INTO files_key_state(id,verifier) VALUES(TRUE,$1)', [verifier]);
  }

  /** Device recovery: replaces the verifier for the new master. */
  async upsertVerifier(client:Queryable, verifier:Envelope):Promise<void> {
    await client.query(
      'INSERT INTO files_key_state(id,verifier) VALUES(TRUE,$1) ON CONFLICT(id) DO UPDATE SET verifier=EXCLUDED.verifier',
      [verifier],
    );
  }
}
