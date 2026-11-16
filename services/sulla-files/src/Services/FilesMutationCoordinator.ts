// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, rmdir } from 'node:fs/promises';

import { FileFingerprints } from './FileFingerprint.js';
import { FilesRootPathGuard } from './FilesRootPathGuard.js';
import { PinnedFilesystemOperations } from './PinnedFilesystemOperations.js';

import type { DirectoryReceipt, EvictionReceipt, FileFingerprint, PublicationReceipt, ReplacementReceipt } from './FileFingerprint.js';
import type { PinnedRegularFile, VerifyPinnedFile as Verify } from './PinnedRegularFile.js';
import type { FileHandle } from 'node:fs/promises';

const { sameFingerprint, sameIdentity } = FileFingerprints;

/**
 * One coordinator must be shared by the watcher, file operations, and
 * residency. The queue is intentionally global: overlapping directory/file
 * operations cannot be proven independent after a concurrent rename.
 */
export class FilesMutationCoordinator {
  static async atomicRenameAvailable():Promise<boolean> {
    return process.platform==='linux' && await access(PinnedFilesystemOperations.renameHelperPath,constants.X_OK).then(()=>true,()=>false);
  }
  static async requireAtomicRename():Promise<void> {
    if (!await this.atomicRenameAvailable()) throw Object.assign(new Error('Native mutation helper is unavailable'), { status:503,code:'native-helper-unavailable' });
  }
  private tail:               Promise<void> = Promise.resolve();
  private readonly scope = new AsyncLocalStorage<boolean>();
  private readonly paths:FilesRootPathGuard;
  private readonly files:PinnedFilesystemOperations;

  constructor(root:string) {
    this.paths = new FilesRootPathGuard(root);
    // Resolved through the class at call time so the availability gate stays one seam.
    this.files = new PinnedFilesystemOperations(this.paths, () => FilesMutationCoordinator.requireAtomicRename());
  }

  runExclusive<T>(_relativePaths:string[], operation:()=>Promise<T>):Promise<T> {
    if (this.scope.getStore()) return operation();
    const result = this.tail.then(() => this.scope.run(true, operation));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  evictVerified(input:{ source: string; quarantine: string; verify: Verify }):Promise<EvictionReceipt> {
    return this.runExclusive([input.source, input.quarantine], async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      const source = await this.files.pinVerified(input.source, input.verify);
      try {
        await this.paths.ensurePrivateParent(input.quarantine);
        if (await this.exists(input.quarantine)) throw new Error('Eviction quarantine already exists');
        await this.files.renameNoReplace(input.source, input.quarantine);
        const moved = await this.files.pinVerified(input.quarantine, input.verify);
        try {
          if (!sameIdentity(source.fingerprint, moved.fingerprint)) {
            await this.files.restoreNoClobber(input.quarantine, input.source);
            throw new Error('Source identity changed during atomic eviction');
          }
          return { source: input.source, quarantine: input.quarantine, fingerprint: moved.fingerprint };
        } finally { await moved.close() }
      } finally { await source.close() }
    });
  }

  publishVerified(input:{ staged: string; target: string; verify: Verify }):Promise<PublicationReceipt> {
    return this.runExclusive([input.staged, input.target], async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      const staged = await this.files.pinVerified(input.staged, input.verify);
      try {
        await this.paths.ensureParent(input.target);
        try { await this.files.link(input.staged, input.target) } catch (error:any) {
          if (error?.code === 'EEXIST') throw new Error('Publication will not overwrite an existing file');
          throw error;
        }
        await this.paths.syncParent(input.target);
        const target = await this.files.pinVerified(input.target, input.verify);
        try {
          if (!sameIdentity(staged.fingerprint, target.fingerprint)) throw new Error('Published file identity does not match its pinned stage');
          return { staged: input.staged, target: input.target, fingerprint: target.fingerprint };
        } finally { await target.close() }
      } finally { await staged.close() }
    });
  }

  /**
   * Replace a tracked file while retaining its previous inode until the caller
   * has durably ingested the new bytes. The second verification happens after
   * rename, so a cooperating caller detects an external write in the
   * check-to-rename window and retains both versions for explicit recovery.
   *
   * This is deliberately not described as a general filesystem CAS: a process
   * that already holds the old inode open can still write after verification.
   * The native source broker must own handles/coordination before this leaves
   * the synthetic feasibility boundary.
   */
  replaceVerified(input:{ staged: string; target: string; backup: string; conflict: string; verifyStaged: Verify; verifyTarget: Verify }):Promise<ReplacementReceipt> {
    return this.runExclusive([input.staged, input.target, input.backup, input.conflict], async() => {
      const target = await this.files.pinVerified(input.target, input.verifyTarget);
      const staged = await this.files.pinVerified(input.staged, input.verifyStaged);
      let published = false;
      try {
        await this.paths.ensurePrivateParent(input.backup);
        if (await this.exists(input.backup)) throw new Error('Replacement recovery file already exists');
        await this.files.link(input.target, input.backup);
        await this.paths.syncParent(input.backup);
        const backup = await this.files.pinVerified(input.backup, input.verifyTarget);
        try {
          if (!sameIdentity(target.fingerprint, backup.fingerprint)) throw new Error('Replacement recovery identity does not match its pinned target');
          const current = await this.files.pinVerified(input.target, input.verifyTarget);
          try {
            if (!sameIdentity(current.fingerprint, backup.fingerprint)) throw new Error('Replacement target identity changed before publication');
          } finally { await current.close() }
          await this.files.renameNoReplace(input.staged, input.target);
          published = true;
          await Promise.all([this.paths.syncParent(input.staged), this.paths.syncParent(input.target)]);
          const replaced = await this.files.pinVerified(input.target, input.verifyStaged);
          try {
            if (!sameIdentity(staged.fingerprint, replaced.fingerprint)) throw new Error('Replacement target identity does not match its pinned stage');
            await input.verifyTarget(backup);
            await backup.assertUnchanged();
            return { target: input.target, backup: input.backup, targetFingerprint: replaced.fingerprint, backupFingerprint: backup.fingerprint };
          } finally { await replaced.close() }
        } catch (error) {
          if (published && await this.exists(input.target).catch(() => false)) {
            try {
              await this.paths.ensureParent(input.conflict);
              await this.files.link(input.target, input.conflict);
              await this.paths.syncParent(input.conflict);
            } catch (preserveError) {
              throw new Error(`Replacement verification failed and automatic recovery stopped because the replacement could not be preserved at ${ input.conflict }; the prior source remains at ${ input.backup }: ${ preserveError instanceof Error ? preserveError.message : String(preserveError) }`, { cause: error });
            }
            throw new Error(`Replacement verification failed; both versions were preserved for recovery at ${ input.conflict } and ${ input.backup }`, { cause: error });
          }
          throw error;
        } finally { await backup.close() }
      } finally { await Promise.all([target.close(), staged.close()]) }
    });
  }

  async preserveReplacement(receipt:ReplacementReceipt, preserve:string, verifyReplacement:Verify):Promise<void> {
    await this.runExclusive([receipt.target, receipt.backup, preserve], async() => {
      const replacement = await this.files.pinVerified(receipt.target, verifyReplacement);
      try {
        if (!sameFingerprint(replacement.fingerprint, receipt.targetFingerprint)) throw new Error('Replacement changed before preservation; recovery files were retained');
        await this.paths.ensureParent(preserve);
        await this.files.link(receipt.target, preserve);
        await this.paths.syncParent(preserve);
      } finally { await replacement.close() }
    });
  }

  async finalizeReplacement(receipt:ReplacementReceipt):Promise<void> {
    await this.runExclusive([receipt.backup], async() => {
      const backup = await this.pin(receipt.backup);
      try {
        if (!sameFingerprint(backup.fingerprint, receipt.backupFingerprint)) throw new Error('Replacement recovery file changed before cleanup');
      } finally { await backup.close() }
      await this.files.unlink(receipt.backup, receipt.backupFingerprint);
      await this.paths.syncParent(receipt.backup);
    });
  }

  copyVerified(input:{ source: string; target: string; verify: Verify; staged?: string }):Promise<PublicationReceipt> {
    return this.runExclusive([input.source, input.target], async() => {
      const source = await this.files.pinVerified(input.source, input.verify);
      const staged = input.staged ?? `.sulla-trash/.residency/${ randomUUID() }.copy`;
      try {
        const output = await this.openPrivateExclusive(staged);
        try {
          for await (const value of source.createReadStream()) {
            const bytes = Buffer.from(value);
            let offset = 0;
            while (offset < bytes.byteLength) {
              const { bytesWritten } = await output.write(bytes, offset);
              if (bytesWritten === 0) throw new Error('Pinned copy made no write progress');
              offset += bytesWritten;
            }
          }
          await output.sync();
        } finally { await output.close() }
        await source.assertUnchanged();
        await input.verify(source);
        return await this.publishVerified({ staged, target: input.target, verify: input.verify });
      } catch (error) {
        // A failed copy may leave partial bytes or an externally replaced
        // stage. Preserve it; journal reconciliation decides ownership.
        throw error;
      } finally { await source.close() }
    });
  }

  async recoverEviction(receipt:EvictionReceipt, verify:Verify):Promise<void> {
    await this.runExclusive([receipt.source, receipt.quarantine], async() => {
      const quarantine = await this.files.pinVerified(receipt.quarantine, verify);
      try {
        if (!sameFingerprint(quarantine.fingerprint, receipt.fingerprint)) throw new Error('Eviction recovery identity changed');
        if (await this.exists(receipt.source)) {
          const restored = await this.pin(receipt.source);
          try {
            if (!sameIdentity(restored.fingerprint, receipt.fingerprint)) {
              throw new Error('Eviction source was replaced; quarantine was preserved for reconciliation');
            }
            await verify(restored);
            await restored.assertUnchanged();
          } finally { await restored.close() }
          await this.files.unlink(receipt.quarantine,receipt.fingerprint);
          return;
        }
        await this.paths.ensureParent(receipt.source);
        await this.files.link(receipt.quarantine, receipt.source);
        const restored = await this.files.pinVerified(receipt.source, verify);
        try {
          if (!sameIdentity(restored.fingerprint, receipt.fingerprint)) throw new Error('Restored source identity does not match eviction receipt');
        } finally { await restored.close() }
        await this.files.unlink(receipt.quarantine,receipt.fingerprint);
      } finally { await quarantine.close() }
    });
  }

  async rollbackPublication(receipt:PublicationReceipt, verify:Verify):Promise<void> {
    await this.runExclusive([receipt.staged, receipt.target], async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      const target = await this.pin(receipt.target);
      const rollback = receipt.rollback ?? `.sulla-trash/.residency/${ randomUUID() }.rollback`;
      try {
        if (!sameFingerprint(target.fingerprint, receipt.fingerprint)) throw new Error('Published target changed before rollback');
        await verify(target);
        await target.assertUnchanged();
        await this.paths.ensurePrivateParent(rollback);
        if (await this.exists(rollback)) throw new Error('Rollback quarantine is occupied; preserved');
        if (!await this.exists(receipt.staged)) await this.files.link(receipt.target, receipt.staged);
        const staged = await this.files.pinVerified(receipt.staged, verify);
        try {
          if (!sameIdentity(staged.fingerprint, receipt.fingerprint)) throw new Error('Rollback stage does not match the published target');
        } finally { await staged.close() }
        await this.files.renameNoReplace(receipt.target, rollback);
        const moved = await this.files.pinVerified(rollback, verify);
        try {
          if (!sameIdentity(moved.fingerprint, receipt.fingerprint)) {
            await this.files.restoreNoClobber(rollback, receipt.target);
            throw new Error('Published target was replaced during rollback; replacement was preserved');
          }
        } finally { await moved.close() }
        // Retain the verified inverse artifact. In journaled operations its
        // deterministic name is derivable from the durable leaf stage.
      } finally { await target.close() }
    });
  }

  openPrivateExclusive(path:string):Promise<FileHandle> { return this.files.openPrivateExclusive(path) }

  directory(path:string):Promise<DirectoryReceipt> { return this.files.directory(path) }

  inspectTree(path:string,allow:(path:string)=>boolean=()=>true):Promise<{directories:string[];files:string[]}> {
    return this.files.inspectTree(path, allow);
  }

  /** Exact mkdir: callers plan every parent separately, including empty dirs. */
  async createDirectory(path:string):Promise<DirectoryReceipt> {
    return this.runExclusive([path],async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      const parent = await this.paths.pinParent(path);
      try { await mkdir(parent.child,{ mode:0o700 }); await parent.handle.sync() } finally { await parent.handle.close() }
      return this.directory(path);
    });
  }

  async stageDirectory(path:string):Promise<DirectoryReceipt> {
    await FilesMutationCoordinator.requireAtomicRename();
    await this.paths.ensurePrivateParent(path);
    return this.createDirectory(path);
  }

  async removeEmptyDirectory(expected:DirectoryReceipt,retained:string):Promise<void> {
    await this.evictEmptyDirectory(expected,retained);
    // The exact, verified empty directory remains retained. Never recursively
    // remove a pathname that another process can replace after verification.
  }

  async evictEmptyDirectory(expected:DirectoryReceipt,retained:string):Promise<void> {
    return this.runExclusive([expected.path],async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      const actual = await this.directory(expected.path);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('Directory identity changed; inverse refused');
      const parent = await this.paths.pinParent(expected.path);
      try {
        if ((await readdir(parent.child)).length) throw new Error('Directory acquired unknown children');
        await this.paths.ensurePrivateParent(retained);
        if (await this.exists(retained)) throw new Error('Directory quarantine is occupied');
        await this.files.renameNoReplace(expected.path,retained);
        const moved=await this.directory(retained);
        if (moved.dev!==expected.dev || moved.ino!==expected.ino) throw new Error('Directory changed during eviction; quarantined entry preserved');
        await this.files.assertEmptyDirectory(retained, 'Quarantined directory has unknown children; preserved');
      } finally { await parent.handle.close() }
    });
  }

  async restoreEmptyDirectory(expected:DirectoryReceipt,retained:string):Promise<DirectoryReceipt> {
    if (await this.exists(expected.path)) {
      const current=await this.directory(expected.path);
      if (current.dev===expected.dev && current.ino===expected.ino && !await this.exists(retained)) return current;
      throw new Error('Directory restore destination is occupied');
    }
    const moved=await this.directory(retained);
    if (moved.dev!==expected.dev || moved.ino!==expected.ino) throw new Error('Retained directory identity changed');
    await this.files.assertEmptyDirectory(retained, 'Retained directory acquired children');
    await this.files.renameNoReplace(retained,expected.path);
    const restored=await this.directory(expected.path);
    if (restored.dev!==expected.dev || restored.ino!==expected.ino) throw new Error('Restored directory identity changed; preserved');
    return restored;
  }

  /** Both old and incoming bytes remain retained for a guarded inverse. */
  async replaceWithRetainedDisplacement(input:{ staged:string; target:string; backup:string; verify:Verify; verifyDisplaced:Verify }):Promise<{ publication:PublicationReceipt; displaced:EvictionReceipt }> {
    return this.runExclusive([input.staged,input.target,input.backup],async() => {
      const displaced = await this.evictVerified({ source:input.target,quarantine:input.backup,verify:input.verifyDisplaced });
      try { return { publication:await this.publishVerified(input),displaced } }
      catch (error) { await this.recoverEviction(displaced,input.verifyDisplaced); throw error }
    });
  }

  async finalizePublication(receipt:PublicationReceipt | EvictionReceipt):Promise<void> {
    const staged = 'staged' in receipt ? receipt.staged : receipt.quarantine;
    await this.runExclusive([staged], async() => {
      const pinned = await this.pin(staged);
      try {
        if (!sameIdentity(pinned.fingerprint, receipt.fingerprint)) throw new Error('Private staged identity changed before cleanup');
      } finally { await pinned.close() }
      await this.files.unlink(staged,receipt.fingerprint);
    });
  }

  /** Dispose one proven retained file. Unknown replacements are never unlinked. */
  async disposeRetainedFile(path:string,expected:FileFingerprint,verify:Verify):Promise<void> {
    await this.runExclusive([path],async()=>{
      const pinned=await this.files.pinVerified(path,verify);
      try {
        if (!sameFingerprint(pinned.fingerprint,expected)) throw new Error('Retained file identity changed; preserved');
        await this.files.unlink(path,pinned.fingerprint);
      } finally { await pinned.close() }
    });
  }

  /** Dispose one proven empty retained directory without recursive deletion. */
  async disposeRetainedDirectory(expected:DirectoryReceipt):Promise<void> {
    await this.runExclusive([expected.path],async()=>{
      const actual=await this.directory(expected.path);
      if (actual.dev!==expected.dev || actual.ino!==expected.ino) throw new Error('Retained directory identity changed; preserved');
      const parent=await this.paths.pinParent(expected.path);
      try {
        if ((await readdir(parent.child)).length) throw new Error('Retained directory acquired unknown children; preserved');
        await rmdir(parent.child); await parent.handle.sync();
      } finally { await parent.handle.close() }
    });
  }

  pinVerified(path:string, verify:Verify):Promise<PinnedRegularFile> { return this.files.pinVerified(path, verify) }

  pin(path:string):Promise<PinnedRegularFile> { return this.files.pin(path) }

  exists(path:string):Promise<boolean> { return this.paths.exists(path) }
}
