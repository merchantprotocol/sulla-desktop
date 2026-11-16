// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { decryptChunk } from './crypto.js';
import { isProtectedPath } from './protectedFiles.js';
import { TrackedPathFilter } from './TrackedPathFilter.js';

import type { FilesIdentity } from './auth.js';
import type { Config, FileRootConfig } from './config.js';
import type { FuseTrackedFile } from './NativeSourceOperations.js';
import type { TrackedFileRepository } from './Repositories/TrackedFileRepository.js';
import type { FilesMutationCoordinator, PinnedRegularFile, ReplacementReceipt } from './safeFilesystem.js';
import type { Store } from './store.js';

/** What the mount borrows from the manager: its serializer, a root rescan, and root lookups. */
export interface TrackedMountHost {
  serial<T>(operation:()=>Promise<T>):Promise<T>;
  scanRoot(root:FileRootConfig):Promise<void>;
  rootIn(collectionId:string):FileRootConfig | undefined;
  rootFor(collectionId:string):FileRootConfig;
}

/**
 * The experimental FUSE view of tracked roots and native sources. Reads are verified against the
 * indexed hash; writes are staged, verified and swapped in, and any race keeps the agent's bytes as
 * a visible conflicted copy instead of overwriting the source.
 */
export class TrackedFuseMount {
  constructor(
    private readonly config:Config,
    private readonly store:Store,
    private readonly repository:TrackedFileRepository,
    private readonly rootMutations:Map<string, FilesMutationCoordinator>,
    private readonly host:TrackedMountHost,
  ) {}

  /** Experimental Files mount view over watched roots and indexed native sources. */
  async snapshot(collectionId:string):Promise<FuseTrackedFile[]> {
    const root = this.host.rootIn(collectionId);
    if (root) await this.host.serial(() => this.host.scanRoot(root));
    const rows = await this.repository.mountView(collectionId, root?.id ?? null);
    return rows.filter(row => !isProtectedPath(row.path)).map(row => ({
      id: row.id, collectionId: row.collection_id, path: row.path, mime: row.mime,
      size: Number(row.size), versionId: row.version_id, sourceHash: row.content_hash, mtimeMs: Number(row.mtime_ms),
    }));
  }

  async read(fileId:string):Promise<{ file:FuseTrackedFile; bytes:Buffer }> {
    const row = await this.row(fileId);
    if (row.native || row.storedNativeConflict) return { file: row, bytes: await this.readStoredVersion(fileId, row.versionId) };
    const root = this.host.rootFor(row.collectionId);
    const pinned = await this.rootMutations.get(root.id)!.pinVerified(row.path, file => this.verifyHash(file, row.sourceHash));
    try {
      const chunks:Buffer[] = [];
      for await (const chunk of pinned.createReadStream()) chunks.push(Buffer.from(chunk));
      await pinned.assertUnchanged();
      return { file: row, bytes: Buffer.concat(chunks) };
    } finally { await pinned.close() }
  }

  async write(fileId:string, expectedVersionId:string, expectedSourceHash:string, bytes:Buffer, actor:FilesIdentity):Promise<FuseTrackedFile & { conflictPath?:string }> {
    const initial = await this.row(fileId);
    if (initial.native) throw Object.assign(new Error('Native source writes require the Electron publication transaction'), { status: 409, code: 'NATIVE_PUBLICATION_REQUIRED' });
    if (initial.storedNativeConflict) throw Object.assign(new Error('Files-only native conflict entries are read-only in the experimental mount'), { status: 409 });
    const root = this.host.rootFor(initial.collectionId);
    const mutations = this.rootMutations.get(root.id)!;
    const operationId = randomUUID();
    const stagedPath = `.sulla-trash/.operations/${ operationId }/${ basename(initial.path) }.write`;
    const backupPath = `.sulla-trash/.operations/${ operationId }/${ basename(initial.path) }.source`;
    const conflict = TrackedPathFilter.conflictPath(initial.path, `${ actor.deviceId || 'fuse' }-${ operationId.slice(0, 8) }`);
    const desiredHash = createHash('sha256').update(bytes).digest('hex');
    return this.host.serial(() => mutations.runExclusive([initial.path, stagedPath, backupPath, conflict], async() => {
      const current = await this.row(fileId);
      if (current.versionId !== expectedVersionId || current.sourceHash !== expectedSourceHash) {
        if (desiredHash === expectedSourceHash) {
          throw Object.assign(new Error('Tracked source changed before the no-op FUSE write was verified; no source bytes were replaced'), { status: 409 });
        }
        const output = await mutations.openPrivateExclusive(stagedPath);
        try {
          let offset = 0;
          while (offset < bytes.byteLength) {
            const result = await output.write(bytes, offset);
            if (!result.bytesWritten) throw new Error('FUSE staging made no write progress');
            offset += result.bytesWritten;
          }
          await output.sync();
        } finally { await output.close() }
        const publication = await mutations.publishVerified({ staged: stagedPath, target: conflict, verify: file => this.verifyHash(file, desiredHash) });
        await mutations.finalizePublication(publication);
        await this.host.scanRoot(root);
        throw Object.assign(new Error('Tracked source changed before the FUSE write was committed; the agent edit was preserved as a conflict'), { status: 409, conflictPath: conflict });
      }
      const verifyExpected = (file:PinnedRegularFile) => this.verifyHash(file, expectedSourceHash);
      if (desiredHash === expectedSourceHash) {
        const unchanged = await mutations.pinVerified(current.path, verifyExpected);
        try { await unchanged.assertUnchanged() } finally { await unchanged.close() }
        return current;
      }
      const output = await mutations.openPrivateExclusive(stagedPath);
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await output.write(bytes, offset);
          if (!result.bytesWritten) throw new Error('FUSE staging made no write progress');
          offset += result.bytesWritten;
        }
        await output.sync();
      } finally { await output.close() }
      const verifyDesired = (file:PinnedRegularFile) => this.verifyHash(file, desiredHash);
      let receipt:ReplacementReceipt | undefined;
      try {
        receipt = await mutations.replaceVerified({ staged: stagedPath, target: current.path, backup: backupPath, conflict, verifyStaged: verifyDesired, verifyTarget: verifyExpected });
      } catch (error) {
        if (await mutations.exists(stagedPath).catch(() => false)) {
          const publication = await mutations.publishVerified({ staged: stagedPath, target: conflict, verify: verifyDesired });
          await mutations.finalizePublication(publication);
        }
        await this.host.scanRoot(root);
        throw Object.assign(new Error('Tracked source changed during the FUSE write; the agent edit was preserved as a conflict'), { status: 409, conflictPath: conflict, cause: error });
      }
      try {
        await this.host.scanRoot(root);
        const committed = await this.row(fileId);
        if (committed.sourceHash !== desiredHash || committed.versionId === expectedVersionId) throw new Error('Files ingestion did not durably record the replacement');
        await mutations.finalizeReplacement(receipt);
        return committed;
      } catch (error) {
        let preserved = false;
        try { await mutations.preserveReplacement(receipt, conflict, verifyDesired); preserved = true } catch { /* Keep both private recovery and current path; never overwrite after failed preservation. */ }
        await this.host.scanRoot(root).catch(() => undefined);
        throw Object.assign(new Error(preserved
          ? 'Files could not durably ingest the FUSE write; agent and prior-source bytes were retained for recovery'
          : 'Files could not durably ingest the FUSE write; automatic recovery stopped without overwriting the current path'), { status: 503, ...(preserved ? { conflictPath: conflict } : {}), cause: error });
      }
    }));
  }

  async row(fileId:string):Promise<FuseTrackedFile & { native?:boolean; storedNativeConflict?:boolean; sourceRevision?:string; sourceHandle?:string }> {
    const row = await this.repository.mountRow(fileId);
    if (!row || isProtectedPath(row.path)) throw Object.assign(new Error('Tracked file is unavailable'), { status: 404 });
    if (row.source_handle) return { id: row.id, collectionId: row.collection_id, path: row.path, mime: row.mime, size: Number(row.size), versionId: row.version_id, sourceHash: row.content_hash, mtimeMs: Number(row.mtime_ms), native: true, sourceRevision: row.source_revision, sourceHandle: row.source_handle };
    if (row.native_conflict_file_id) return { id: row.id, collectionId: row.collection_id, path: row.path, mime: row.mime, size: Number(row.size), versionId: row.version_id, sourceHash: row.content_hash, mtimeMs: Number(row.mtime_ms), storedNativeConflict: true };
    const root = this.host.rootFor(row.collection_id);
    if (row.root_id !== root.id) throw Object.assign(new Error('Tracked file is not watched by its configured Files root'), { status: 409 });
    return { id: row.id, collectionId: row.collection_id, path: row.path, mime: row.mime, size: Number(row.size), versionId: row.version_id, sourceHash: row.content_hash, mtimeMs: Number(row.mtime_ms) };
  }

  async readStoredVersion(fileId:string, versionId:string):Promise<Buffer> {
    const row = await this.repository.storedVersion(fileId, versionId);
    if (!row || Number(row.size) > 64 * 1024 * 1024) throw Object.assign(new Error('Files version is unavailable or exceeds the native source bound'), { status: 413 });
    const keys = await this.config.keyring!.keys(row.chunk_collection_id);
    const chunks:Buffer[] = [];
    for (const id of row.chunk_ids as string[]) chunks.push(Buffer.from(await decryptChunk(await this.store.get(row.chunk_collection_id, id), keys.data, id)));
    const bytes = Buffer.concat(chunks).subarray(0, Number(row.size));
    if (bytes.byteLength !== Number(row.size)) throw new Error('Files version length does not match its manifest');
    return bytes;
  }

  private async verifyHash(file:PinnedRegularFile, expected:string):Promise<void> {
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream()) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw Object.assign(new Error('Tracked source hash changed'), { status: 409 });
  }

}
