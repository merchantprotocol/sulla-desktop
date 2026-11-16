// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import { SerializableTransactionRepository } from '../Repositories/SerializableTransactionRepository.js';
import { OperationFailure } from './OperationFailure.js';

const SERIALIZATION_RETRY_CODES = ['40001', '40P01'];
const MAX_TRANSACTION_ATTEMPTS = 4;

/**
 * Runs receipt work in one SERIALIZABLE transaction, retrying the body (never COMMIT)
 * on serialization failure or deadlock. Namespace triggers serialize legacy writers per
 * collection; SERIALIZABLE protects ACL/custody predicates without a service-wide lock
 * across the operation. External identity membership is prepared before BEGIN.
 */
export class SerializableTransaction {
  constructor(private readonly db:Pick<pg.Pool, 'connect'>, private readonly control = new SerializableTransactionRepository()) {}

  async run<T>(work:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
      const client = await this.db.connect();
      let commitAttempted = false; let committed = false; let retry = false;
      try {
        await this.control.begin(client);
        const result = await work(client);
        commitAttempted = true;
        await this.control.commit(client); committed = true;
        return result;
      } catch (error:any) {
        await this.control.rollback(client).catch(() => undefined);
        // ROLLBACK guarantees nothing from work() persisted, so re-running it in a
        // fresh transaction is safe — but only retry failures from the body, not
        // from COMMIT itself, and only for the two codes that mean "try again",
        // not a real conflict (23505), lock timeout (55P03), or statement timeout (57014).
        retry = !commitAttempted && SERIALIZATION_RETRY_CODES.includes(error?.code) && attempt < MAX_TRANSACTION_ATTEMPTS;
        if (!retry) {
          if (['40001', '40P01', '23505', '55P03', '57014'].includes(error?.code)) throw OperationFailure.busy();
          throw error;
        }
      } finally { client.release(commitAttempted && !committed) }
      await new Promise(resolve => setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 20)));
    }
    throw OperationFailure.busy();
  }
}
