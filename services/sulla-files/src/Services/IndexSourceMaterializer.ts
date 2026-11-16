// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { decryptChunk } from '../crypto.js';
import { assertUnprotectedFile, isProtectedPath, protectedPathError } from '../protectedFiles.js';
import { FilesMutationCoordinator } from '../safeFilesystem.js';

import type { Config } from '../config.js';
import type { IndexSourceRepository } from '../Repositories/IndexSourceRepository.js';
import type { Store } from '../store.js';
import type pg from 'pg';

const MAX_INDEX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

export interface MaterializedIndexSource { path:string; cleanup:() => Promise<void> }

type Writable = Awaited<ReturnType<typeof open>>;

/** Writes all of `bytes`, failing instead of spinning when the file makes no progress. */
async function writeAll(output:Writable, bytes:Buffer, stalled:string):Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await output.write(bytes, offset, bytes.byteLength - offset);
    if (!bytesWritten) throw new Error(stalled);
    offset += bytesWritten;
  }
}

function removal(path:string):() => Promise<void> { return async() => { await unlink(path).catch(() => undefined) } }

/**
 * Copies a live file from its enabled Files root into a private temp snapshot, bounded at
 * 2 GiB, and fails if the file changed while it was copied.
 */
export class DesktopIndexSource {
  constructor(private readonly filesRoot:string, private readonly db?:Pick<pg.Pool, 'query'>, private readonly roots?:IndexSourceRepository) {}

  private inside(root:string, relativePath:string):string {
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${ root }${ sep }`)) throw new Error('Index source path escapes its Files root');
    return target;
  }

  async materialize(file:any):Promise<MaterializedIndexSource> {
    if (isProtectedPath(file.path)) throw protectedPathError();
    if (this.db) await assertUnprotectedFile(this.db, file);
    const root = this.roots ? await this.roots.enabledRootPath(file.collection_id) : this.filesRoot;
    if (!root) throw new Error('Index source collection has no active Files root');
    const relativePath = file.path;
    this.inside(resolve(root), relativePath);
    const pinned = await new FilesMutationCoordinator(root).pin(relativePath);
    const tempRoot = join(tmpdir(), 'sulla-files-index');
    const path = join(tempRoot, randomUUID());
    let output:Writable | undefined;
    try {
      if (pinned.fingerprint.size > MAX_INDEX_SOURCE_BYTES) throw new Error('Index source exceeds the 2 GiB local extraction limit');
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      output = await open(path, 'wx', 0o600);
      let total = 0;
      for await (const value of pinned.createReadStream()) {
        const bytes = Buffer.from(value); total += bytes.byteLength;
        if (total > MAX_INDEX_SOURCE_BYTES) throw new Error('Index source exceeded the 2 GiB local extraction limit while copying');
        await writeAll(output, bytes, 'Index source snapshot made no write progress');
      }
      await output.sync(); await output.close(); output = undefined;
      await pinned.assertUnchanged();
      return { path, cleanup: removal(path) };
    } catch (error) {
      await output?.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    } finally { await pinned.close() }
  }
}

/**
 * Decrypts a stored file version into a private temp file under the data root, checking the
 * total against the manifest's committed size. Evicted chunks hydrate through the chunk store.
 */
export class StoredIndexSource {
  private readonly tempRoot:string;

  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly config:Config, private readonly store:Store, private readonly manifests:IndexSourceRepository) {
    this.tempRoot = join(config.dataRoot, 'index-tmp');
  }

  async materialize(file:any):Promise<MaterializedIndexSource> {
    await assertUnprotectedFile(this.db, file);
    const row = await this.manifests.versionManifest(file.current_version_id);
    if (!row) throw new Error('Index source version has no manifest');
    const expectedSize = Number(row.total_size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_INDEX_SOURCE_BYTES) throw new Error('Index source exceeds the 2 GiB local extraction limit');
    const key = (await this.config.keyring!.keys(row.chunk_collection_id)).data;
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const path = join(this.tempRoot, randomUUID()); const output = await open(path, 'wx', 0o600);
    try {
      let total = 0;
      for (const id of row.chunk_ids) {
        const bytes = Buffer.from(await decryptChunk(await this.store.get(row.chunk_collection_id, id), key, id));
        total += bytes.byteLength;
        if (total > expectedSize || total > MAX_INDEX_SOURCE_BYTES) throw new Error('Index source version exceeded its committed size');
        await writeAll(output, bytes, 'Index source materialization made no write progress');
      }
      if (total !== expectedSize) throw new Error('Index source version did not match its committed size');
      await output.sync(); await output.close();
      return { path, cleanup: removal(path) };
    } catch (error) {
      await output.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }
}
