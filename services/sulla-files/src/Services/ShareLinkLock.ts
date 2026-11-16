// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { ShareLinkRepository } from '../Repositories/ShareLinkRepository.js';

/**
 * Serialises every mutation of one share link: an in-process queue per link id, then a
 * Postgres session advisory lock held on one dedicated client for the whole operation.
 */
export class ShareLinkLock {
  private readonly linkLocks = new Map<string, Promise<void>>();

  constructor(private readonly db:Pick<pg.Pool, 'connect'>, private readonly links:ShareLinkRepository) {}

  async run<T>(id:string, operation:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
    const previous = this.linkLocks.get(id) ?? Promise.resolve();
    let release:()=>void = () => {};
    const current = new Promise<void>(resolve => { release = resolve });
    const tail = previous.then(() => current);

    this.linkLocks.set(id, tail);
    await previous;
    let client:pg.PoolClient | undefined;
    let databaseLockHeld = false;
    let operationFailed = false; let operationError:unknown; let result:T | undefined;
    try {
      client = await this.db.connect();
      await this.links.acquireLinkLock(client, id);
      databaseLockHeld = true;
      result = await operation(client);
    } catch (error) { operationFailed = true; operationError = error }
    let unlockError:Error | undefined;
    try { if (databaseLockHeld) await this.links.releaseLinkLock(client!, id); } catch (error) {
      unlockError = error instanceof Error ? error : new Error(String(error));
    }
    try { client?.release(unlockError) } catch (error) { unlockError ??= error instanceof Error ? error : new Error(String(error)) }
    release();
    if (this.linkLocks.get(id) === tail) this.linkLocks.delete(id);
    if (unlockError) throw unlockError;
    if (operationFailed) throw operationError;
    return result!;
  }
}
