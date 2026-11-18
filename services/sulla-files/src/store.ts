// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { TransactionScope } from './TransactionScope.js';
import type pg from 'pg';

export class Store {
  constructor(private root:string) {}

  get rootPath():string { return this.root }

  path(collectionId:string, id:string) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[\w-]+$/.test(collectionId)) throw new Error('bad chunk');
    return join(this.root, collectionId, id.slice(0, 2), id);
  }

  async has(collectionId:string, id:string) {
    let handle;
    try {
      handle = await open(this.path(collectionId, id), constants.O_RDONLY | constants.O_NOFOLLOW);
      return (await handle.stat()).isFile();
    } catch { return false } finally { await handle?.close() }
  }

  /**
   * Whether the chunk is in the store, answered by one synchronous lstat. For checks made while a
   * database transaction is open: the async has() needs three libuv threadpool jobs (open, fstat,
   * close) that queue behind other requests' chunk fsyncs, so under concurrent writes the
   * transaction sat idle, holding its locks, for as long as those fsyncs took. A single local
   * lstat does not wait on that queue. Symlinks are refused, as has() refuses them via O_NOFOLLOW.
   */
  presentNow(collectionId:string, id:string):boolean {
    try { return lstatSync(this.path(collectionId, id)).isFile() } catch { return false }
  }

  /** Stored (encrypted) size of a chunk, or undefined when it is not in the store. */
  async storedSize(collectionId:string, id:string):Promise<number | undefined> {
    let handle;
    try {
      handle = await open(this.path(collectionId, id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      return info.isFile() ? info.size : undefined;
    } catch { return undefined } finally { await handle?.close() }
  }

  async get(collectionId:string, id:string):Promise<Buffer> {
    return readFile(this.path(collectionId, id));
  }

  async getBounded(collectionId:string, id:string, maxBytes:number, expectedBytes:number):Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(expectedBytes) || maxBytes < 0 || expectedBytes < 0 || expectedBytes > maxBytes) throw new Error('Invalid chunk read bound');
    const handle = await open(this.path(collectionId, id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Invalid stored chunk for ${ id }`);
      const bytes = Buffer.allocUnsafe(expectedBytes);
      let offset = 0;
      while (offset < expectedBytes) {
        const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
        if (result.bytesRead === 0) throw new Error(`Stored chunk is shorter than declared for ${ id }`);
        offset += result.bytesRead;
      }
      const overflow = Buffer.allocUnsafe(1);
      if ((await handle.read(overflow, 0, 1, expectedBytes)).bytesRead !== 0) throw new Error(`Stored chunk is longer than declared for ${ id }`);
      const final = await handle.stat();
      if (!final.isFile() || final.size !== expectedBytes) throw new Error(`Stored chunk metadata changed during read for ${ id }`);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async put(collectionId:string, id:string, bytes:Uint8Array):Promise<boolean> {
    // An fsync'd chunk write under load takes seconds: never while a transaction is open.
    TransactionScope.assertOutside('a chunk store write');
    const target = this.path(collectionId, id);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${ target }.tmp-${ process.pid }-${ randomUUID() }`;
    let ownsTemp = false;
    try {
      const handle = await open(temp, 'wx', 0o600);
      ownsTemp = true;
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      try {
        await link(temp, target);
        return true;
      } catch (error:any) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await existing.stat();
          if (!info.isFile() || info.size !== bytes.byteLength) throw new Error(`Immutable chunk collision for ${ id }`);
        } finally { await existing.close() }
        return false;
      }
    } finally {
      if (ownsTemp) await rm(temp, { force: true });
    }
  }

  /** Preserve the invalid immutable object, then atomically publish verified replacement bytes. */
  async quarantineAndReplace(collectionId:string, id:string, bytes:Uint8Array):Promise<{oldBlobRef:string; newBlobRef:string}> {
    TransactionScope.assertOutside('a quarantined chunk replacement');
    const target = this.path(collectionId, id);
    const oldBlobRef = `${target}.quarantine-${Date.now()}-${randomUUID()}`;
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await mkdir(dirname(target), { recursive:true, mode:0o700 });
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try {
      // Hard-link the old inode for audit retention, then atomically replace the live name.
      // Existing manifests still resolve by chunk id to the live name; HMAC identity means
      // their plaintext is exactly the replacement plaintext, despite the old ciphertext being bad.
      await link(target, oldBlobRef);
      await rename(temp, target);
      return { oldBlobRef, newBlobRef:target };
    } finally { await rm(temp, { force:true }) }
  }

  /** Version staging writes the immutable blob before DB commit and records cache residency in that commit. */
  async putStaged(collectionId:string, id:string, bytes:Uint8Array):Promise<boolean> { return this.put(collectionId, id, bytes) }

  /** Hook for derived residency bookkeeping; plain stores have no cache ledger. */
  async recordResident(_client:pg.PoolClient, _collectionId:string, _id:string, _storedBytes:number):Promise<void> {}

  async delete(collectionId:string, id:string) {
    await rm(this.path(collectionId, id), { force: true });
  }
}
