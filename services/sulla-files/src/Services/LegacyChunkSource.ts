// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { constants, open, readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { FileHandle } from 'node:fs/promises';

/**
 * Reads the retired runtime's `<collection>/<bucket>/<chunk>` tree. Every directory
 * descriptor is pinned (O_NOFOLLOW via /proc/self/fd) before the next component opens,
 * so a swapped symlink can never redirect a read outside the source root.
 */
export class LegacyChunkSource {
  static readonly UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  static readonly CHUNK = /^[0-9a-f]{64}$/;
  static readonly BUCKET = /^[0-9a-f]{2}$/;
  static readonly MAX_ENCRYPTED_CHUNK = 32 * 1024 * 1024;

  static validId(value:string, expression:RegExp, label:string):string {
    if (!expression.test(value)) throw new Error(`Invalid legacy ${ label } identity`);
    return value;
  }

  /** Pins every directory descriptor before opening the next component. */
  async read(root:string, collectionId:string, id:string):Promise<Buffer> {
    const collection = LegacyChunkSource.validId(collectionId, LegacyChunkSource.UUID, 'collection');
    const chunk = LegacyChunkSource.validId(id, LegacyChunkSource.CHUNK, 'chunk');
    const rootHandle = await this.openDirectory(root);
    let collectionHandle:FileHandle | undefined; let bucketHandle:FileHandle | undefined; let file:FileHandle | undefined;
    try {
      collectionHandle = await this.openChild(rootHandle, collection, LegacyChunkSource.UUID, 'collection');
      bucketHandle = await this.openChild(collectionHandle, chunk.slice(0, 2), LegacyChunkSource.BUCKET, 'bucket');
      const leaf = await this.exactEntry(bucketHandle, chunk, LegacyChunkSource.CHUNK, 'chunk');
      file = await open(this.fdPath(bucketHandle, leaf), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0 || info.size > LegacyChunkSource.MAX_ENCRYPTED_CHUNK) throw new Error('Legacy Files chunk has an invalid stored size');
      return await file.readFile();
    } finally { await file?.close(); await bucketHandle?.close(); await collectionHandle?.close(); await rootHandle.close() }
  }

  /** Canonical (lower-case) collection id → on-disk name, for collections that hold at least one chunk. */
  async layoutIds(root:string):Promise<Map<string, string>> {
    const rootHandle = await this.openDirectory(root); const ids = new Map<string, string>();
    try {
      for (const entry of await this.entries(rootHandle)) {
        if (!LegacyChunkSource.UUID.test(entry.name)) continue;
        const canonical = entry.name.toLowerCase();
        if (ids.has(canonical)) throw new Error('Legacy Files import found ambiguous collection identities');
        let collection:FileHandle | undefined;
        try {
          collection = await this.openChild(rootHandle, entry.name, LegacyChunkSource.UUID, 'collection'); let found = false;
          for (const bucket of await this.entries(collection)) {
            if (!LegacyChunkSource.BUCKET.test(bucket.name)) continue;
            let bucketHandle:FileHandle | undefined;
            try {
              bucketHandle = await this.openChild(collection, bucket.name, LegacyChunkSource.BUCKET, 'bucket');
              if ((await this.entries(bucketHandle)).some(chunk => chunk.isFile() && LegacyChunkSource.CHUNK.test(chunk.name))) { found = true; break }
            } finally { await bucketHandle?.close() }
          }
          if (found) ids.set(canonical, entry.name);
        } finally { await collection?.close() }
      }
      return ids;
    } finally { await rootHandle.close() }
  }

  /** Like layoutIds, but a missing source root means "no external layout". */
  async optionalLayoutIds(root:string):Promise<Map<string, string>> {
    try { return await this.layoutIds(root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
  }

  private fdPath(handle:FileHandle, name?:string):string {
    return name === undefined ? `/proc/self/fd/${ handle.fd }` : `/proc/self/fd/${ handle.fd }/${ name }`;
  }

  private async openDirectory(path:string):Promise<FileHandle> {
    if (!isAbsolute(path)) throw new Error('Legacy Files import requires an absolute source root');
    let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const component of path.split('/').filter(Boolean)) {
        if (component === '.' || component === '..') throw new Error('Legacy Files import rejected an unsafe source root');
        const child = await open(this.fdPath(handle, component), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (!(await child.stat()).isDirectory()) { await child.close(); throw new Error('Legacy Files import rejected a non-directory path') }
        await handle.close(); handle = child;
      }
      return handle;
    } catch (error) { await handle.close(); throw error }
  }

  private async entries(handle:FileHandle) {
    return readdir(this.fdPath(handle), { withFileTypes: true });
  }

  private async exactEntry(parent:FileHandle, requested:string, expression:RegExp, label:string):Promise<string> {
    LegacyChunkSource.validId(requested, expression, label);
    const matches = (await this.entries(parent)).filter(entry => expression.test(entry.name) && entry.name.toLowerCase() === requested.toLowerCase());
    if (matches.length > 1) throw new Error(`Legacy Files import found ambiguous ${ label } identities`);
    if (!matches.length) throw Object.assign(new Error(`Legacy Files ${ label } does not exist`), { code: 'ENOENT' });
    return matches[0].name;
  }

  private async openChild(parent:FileHandle, requested:string, expression:RegExp, label:string):Promise<FileHandle> {
    const name = await this.exactEntry(parent, requested, expression, label);
    const handle = await open(this.fdPath(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isDirectory()) { await handle.close(); throw new Error(`Legacy Files import rejected a linked or non-directory ${ label }`) }
    return handle;
  }
}
