// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import { TransactionScope } from './TransactionScope.js';

/**
 * A request failed because its database connection was lost (Postgres terminated it, the
 * idle-in-transaction timeout fired, the server restarted). Nothing was committed unless
 * `commitOutcomeUnknown` is set; either way the caller may retry the same request.
 */
export class RetryableDatabaseError extends Error {
  readonly status = 503;
  readonly code = 'FILES_DB_RETRYABLE';
  readonly retryAfterSeconds = 1;

  constructor(readonly commitOutcomeUnknown:boolean, readonly cause?:unknown) {
    super(commitOutcomeUnknown
      ? 'Files lost its database connection while committing; retry the request'
      : 'Files lost its database connection; nothing was saved, retry the request');
  }
}

/** Recognises errors that mean "this connection is gone", as opposed to a statement that failed. */
export class DatabaseFailureClassifier {
  // 57P01-03 admin/crash shutdown, 25P03 idle-in-transaction timeout, 08xxx connection exceptions.
  private static readonly connectionCodes = new Set(['57P01', '57P02', '57P03', '25P03', '08000', '08001', '08003', '08004', '08006', '08007']);
  private static readonly connectionMessages = [
    'connection terminated', 'not queryable', 'connection error', 'econnreset', 'econnrefused', 'epipe',
    'terminating connection', 'client was closed', 'cannot use a pool after calling end',
    // pg-pool's connectionTimeoutMillis: the pool is saturated, nothing ran, the request may retry.
    'timeout exceeded when trying to connect',
  ];

  isConnectionLoss(error:unknown):boolean {
    if (!error || typeof error !== 'object') return false;
    if (error instanceof RetryableDatabaseError) return true;
    const code = String((error as { code?:unknown }).code ?? '');
    if (DatabaseFailureClassifier.connectionCodes.has(code)) return true;
    const message = String((error as { message?:unknown }).message ?? '').toLowerCase();
    return DatabaseFailureClassifier.connectionMessages.some(fragment => message.includes(fragment));
  }
}

type TransactionPool = Pick<pg.Pool, 'connect'>;

export interface TransactionObserver {
  slowTransaction(name:string, milliseconds:number):void;
}

/**
 * Runs one short database transaction. Slow work (chunk encryption, fsync, Vault, hashing,
 * reads through the pool) belongs before `run`, never inside `work`: a transaction that
 * waits on anything other than its own statements sits "idle in transaction" and Postgres
 * terminates it after idle_in_transaction_session_timeout.
 *
 * A lost connection never leaves a half-written version: Postgres rolls the transaction
 * back, the broken client is evicted from the pool, and the caller gets a
 * RetryableDatabaseError (HTTP 503) instead of a hang or an opaque 500.
 *
 * `work` runs inside a TransactionScope: reaching the pool again (requireFile/requirePath
 * without the client, loadFileContent, a nested run) or staging chunks from inside it fails in
 * tests and is logged in production. Pass `client` to every lookup made inside `work`.
 */
export class TransactionRunner {
  constructor(
    private readonly db:TransactionPool,
    private readonly classifier = new DatabaseFailureClassifier(),
    private readonly observer:TransactionObserver = { slowTransaction: (name, ms) => console.warn(`[SullaFiles] slow transaction ${ name } held ${ ms }ms`) },
    private readonly slowMs = 1_000,
  ) {}

  async run<T>(name:string, work:(client:pg.PoolClient) => Promise<T>):Promise<T> {
    TransactionScope.assertOutside('starting a nested transaction');
    let client:pg.PoolClient;
    try { client = await this.db.connect() } catch (error) { throw this.translate(error, false) }
    let began = 0; let committing = false;
    try {
      await client.query('BEGIN'); began = Date.now();
      // While `work` runs, a pool acquire or chunk staging anywhere below it is a scope violation.
      const result = await TransactionScope.within(name, () => work(client));
      committing = true;
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      const lost = this.classifier.isConnectionLoss(error);
      let releaseError:Error | undefined = lost ? error as Error : undefined;
      if (!lost && began) {
        // ROLLBACK on a dead client throws too; that must not replace the real error or leak the client.
        await client.query('ROLLBACK').catch(rollbackError => { releaseError = rollbackError as Error });
      }
      client.release(releaseError ?? undefined);
      throw lost ? this.translate(error, committing) : error;
    } finally {
      if (began) { const held = Date.now() - began; if (held >= this.slowMs) this.observer.slowTransaction(name, held) }
    }
  }

  private translate(error:unknown, committing:boolean):unknown {
    if (error instanceof RetryableDatabaseError) return error;
    return this.classifier.isConnectionLoss(error) ? new RetryableDatabaseError(committing, error) : error;
  }
}
