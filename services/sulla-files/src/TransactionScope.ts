// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AsyncLocalStorage } from 'node:async_hooks';

import type pg from 'pg';

/**
 * Slow work was started while a database transaction was open: a second pool acquire
 * (requireFile/requirePath/loadFileContent/readStoredVersion through the pool, a nested
 * TransactionRunner) or chunk staging (encrypt + fsync). Under load that is exactly what
 * starved the pool and left sessions idle in transaction until Postgres killed them.
 */
export class TransactionScopeViolation extends Error {
  readonly code = 'FILES_TRANSACTION_SCOPE_VIOLATION';
  constructor(readonly transaction:string, readonly operation:string) {
    super(`${ operation } ran inside the open "${ transaction }" transaction; do it before TransactionRunner.run (stage first, short transaction)`);
  }
}

export type TransactionScopeMode = 'throw' | 'warn' | 'off';

interface OpenTransaction { readonly name:string; open:boolean }

/**
 * Knows, per async context, whether a TransactionRunner callback is running.
 *
 * Why a runtime guard rather than a static scan: the starvation was never a literal
 * `db.connect()` inside a transaction. It was helpers several calls deep (requireCollection →
 * resolveCollectionAccess → pool, CachingStore.put → fsync, keyring → Vault) that look harmless
 * at the call site. AsyncLocalStorage follows every await, so the guarded resources themselves
 * (pool acquire, version staging, chunk writes) can tell when they were reached from inside an
 * open transaction, however indirect the path. Tests run in "throw" mode, so a regression fails
 * the spec that exercises it; production defaults to "warn" so a missed path is logged with a
 * stack instead of failing a user's save.
 */
export class TransactionScope {
  private static readonly storage = new AsyncLocalStorage<OpenTransaction>();
  private static warned = new Set<string>();

  /** Mode from SULLA_FILES_TRANSACTION_GUARD, else "throw" under vitest/NODE_ENV=test, else "warn". */
  static mode():TransactionScopeMode {
    const configured = process.env.SULLA_FILES_TRANSACTION_GUARD;
    if (configured === 'throw' || configured === 'warn' || configured === 'off') return configured;
    return process.env.VITEST || process.env.NODE_ENV === 'test' ? 'throw' : 'warn';
  }

  /** Runs `work` marked as inside transaction `name`; the mark ends when `work` settles. */
  static async within<T>(name:string, work:() => Promise<T>):Promise<T> {
    const state:OpenTransaction = { name, open: true };
    try { return await TransactionScope.storage.run(state, work) } finally { state.open = false }
  }

  static current():string | undefined {
    const state = TransactionScope.storage.getStore();
    return state?.open ? state.name : undefined;
  }

  /** Call at the top of anything that must never run while a transaction is open. */
  static assertOutside(operation:string, mode:TransactionScopeMode = TransactionScope.mode()):void {
    const transaction = TransactionScope.current();
    if (!transaction || mode === 'off') return;
    const violation = new TransactionScopeViolation(transaction, operation);
    if (mode === 'throw') throw violation;
    const key = `${ transaction }:${ operation }`;
    if (TransactionScope.warned.has(key)) return;
    TransactionScope.warned.add(key);
    console.warn(`[SullaFiles] ${ violation.message }`, violation.stack);
  }

  /**
   * Makes every acquire from `pool` (connect, and query, which acquires) check the scope. A
   * transaction's own statements go through its checked-out client and are never affected.
   */
  static guardPool<P extends Pick<pg.Pool, 'connect' | 'query'>>(pool:P, mode?:TransactionScopeMode):P {
    const connect = pool.connect.bind(pool) as (...args:any[]) => any;
    const query = pool.query.bind(pool) as (...args:any[]) => any;
    pool.connect = ((...args:any[]) => { TransactionScope.assertOutside('a database pool acquire', mode); return connect(...args) }) as P['connect'];
    pool.query = ((...args:any[]) => { TransactionScope.assertOutside('a database pool query', mode); return query(...args) }) as P['query'];
    return pool;
  }
}
