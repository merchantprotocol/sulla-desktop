// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SchemaMigrationRepository } from './Repositories/SchemaMigrationRepository.js';
import { TransactionControlRepository } from './Repositories/TransactionControlRepository.js';

import type pg from 'pg';

/**
 * Applies services/sulla-files/migrations/*.sql in name order, each in its own transaction,
 * on one connection that holds a cross-process advisory lock. Lock contention and
 * deadlocks retry up to 3 times; anything else fails startup.
 */
export class FilesMigrator {
  private static readonly APPLICATION = 'sulla-files-migrate';
  private static readonly LOCK = 8_795_043;
  private static readonly RETRIES = 3;

  constructor(
    private readonly schema = new SchemaMigrationRepository(),
    private readonly control = new TransactionControlRepository(),
    private readonly directory = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations'),
    private readonly sleep:(ms:number) => Promise<unknown> = ms => new Promise(done => setTimeout(done, ms)),
  ) {}

  async migrate(db:Pick<pg.Pool, 'connect'>):Promise<void> {
    const dir = this.directory;
    const files = (await readdir(dir)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
    const c = await db.connect();
    try {
      // Use an unnamed connection until the lock is held: concurrent live
      // starters then wait instead of terminating each other.
      await this.schema.terminatePeers(c, FilesMigrator.APPLICATION);
      await this.schema.lock(c, FilesMigrator.LOCK);
      await this.schema.terminatePeers(c, FilesMigrator.APPLICATION);
      await this.schema.tagSession(c, FilesMigrator.APPLICATION);
      await this.schema.ensureLedger(c);
      for (const file of files) {
        if (await this.schema.isApplied(c, file)) continue;
        await this.apply(c, file, await readFile(resolve(dir, file), 'utf8'));
      }
      // A database first started on the stock image records the optional migration without pgvector.
      // Retry it after an image upgrade; it is idempotent and returns immediately once the table exists.
      const vector = await this.schema.vectorReadiness(c);
      if (!vector.ready && vector.available) await this.schema.runScript(c, await readFile(resolve(dir, '045_pgvector_search.sql'), 'utf8'));
    } finally {
      await this.schema.unlock(c, FilesMigrator.LOCK).catch(() => undefined); c.release();
    }
  }

  private async apply(c:pg.PoolClient, file:string, sql:string):Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      console.log(`[SullaFiles] migration ${ file } starting (attempt ${ attempt }/${ FilesMigrator.RETRIES })`);
      try {
        await this.control.begin(c); await this.schema.runScript(c, sql);
        await this.schema.recordApplied(c, file); await this.control.commit(c);
        console.log(`[SullaFiles] migration ${ file } completed in ${ Date.now() - started }ms`); return;
      } catch (error) {
        await this.control.rollback(c).catch(() => undefined);
        if (!this.retryable(error) || attempt >= FilesMigrator.RETRIES) throw error;
        const delay = attempt * 1_000;
        console.warn(`[SullaFiles] migration ${ file } lock contention after ${ Date.now() - started }ms; retrying in ${ delay }ms`);
        await this.sleep(delay);
      }
    }
  }

  private retryable(error:unknown):boolean {
    return typeof error === 'object' && error !== null && ['55P03', '40P01', '40001'].includes(String((error as { code?:string }).code));
  }
}
