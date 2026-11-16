// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, sep } from 'node:path';

import { FileFingerprints } from './FileFingerprint.js';
import { PinnedRegularFile } from './PinnedRegularFile.js';

import type { DirectoryReceipt, FileFingerprint } from './FileFingerprint.js';
import type { FilesRootPathGuard } from './FilesRootPathGuard.js';
import type { VerifyPinnedFile } from './PinnedRegularFile.js';
import type { FileHandle } from 'node:fs/promises';

/**
 * Single-entry filesystem primitives over parents pinned by FilesRootPathGuard: open regular
 * files O_NOFOLLOW, hard-link, no-replace rename (Linux renameat2 helper), identity-checked unlink
 * and directory inspection. None of them serialize; FilesMutationCoordinator owns the queue.
 */
export class PinnedFilesystemOperations {
  static readonly renameHelperPath = '/usr/local/bin/sulla-files-rename-noreplace';

  constructor(
    private readonly paths:FilesRootPathGuard,
    private readonly requireAtomicRename:() => Promise<void>,
  ) {}

  async pinVerified(path:string, verify:VerifyPinnedFile):Promise<PinnedRegularFile> {
    const pinned = await this.pin(path);
    try { await verify(pinned); await pinned.assertUnchanged(); return pinned } catch (error) { await pinned.close(); throw error }
  }

  async pin(path:string):Promise<PinnedRegularFile> {
    await this.paths.assertParentInsideRoot(path);
    const parent = await this.paths.pinParent(path);
    const handle = await open(parent.child, constants.O_RDONLY | constants.O_NOFOLLOW).finally(() => parent.handle.close());
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) throw new Error('Files mutation target must be a regular file');
      const actual = await realpath(`/proc/self/fd/${ handle.fd }`).catch(() => '');
      const root = await this.paths.ready();
      if (!actual || (actual !== root && !actual.startsWith(`${ root }${ sep }`))) throw new Error('Pinned file escaped the Files root');
      return new PinnedRegularFile(this.paths.clean(path), FileFingerprints.from(stats), handle);
    } catch (error) { await handle.close(); throw error }
  }

  async openPrivateExclusive(path:string):Promise<FileHandle> {
    await this.requireAtomicRename();
    await this.paths.ensurePrivateParent(path);
    const parent = await this.paths.pinParent(path);
    try {
      const handle = await open(parent.child, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await parent.handle.sync(); return handle } catch (error) { await handle.close(); throw error }
    } finally { await parent.handle.close() }
  }

  async directory(path:string):Promise<DirectoryReceipt> {
    const parent = await this.paths.pinParent(path);
    try {
      const handle = await open(parent.child,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (await realpath(`/proc/self/fd/${handle.fd}`) !== this.paths.absolute(path)) throw new Error('Directory moved during verification');
        const info = await handle.stat({ bigint:true });
        return { path,dev:String(info.dev),ino:String(info.ino) };
      } finally { await handle.close() }
    } finally { await parent.handle.close() }
  }

  async inspectTree(path:string,allow:(path:string)=>boolean=()=>true):Promise<{directories:string[];files:string[]}> {
    const directories:string[]=[]; const files:string[]=[];
    const visit=async(current:string):Promise<void>=>{
      if (!allow(current)) throw new Error('Folder contains a protected path');
      const expected=await this.directory(current); directories.push(current);
      const parent=await this.paths.pinParent(current);
      const handle=await open(parent.child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW).finally(()=>parent.handle.close());
      try {
        const info=await handle.stat({bigint:true});
        if (String(info.dev)!==expected.dev || String(info.ino)!==expected.ino) throw new Error('Folder changed during enumeration');
        const names=(await readdir(`/proc/self/fd/${handle.fd}`)).sort();
        for (const name of names) {
          const relative=current+'/'+name;
          if (!allow(relative)) throw new Error('Folder contains a protected path');
          const entry=await lstat(`/proc/self/fd/${handle.fd}/${name}`);
          if (entry.isDirectory()) await visit(relative);
          else if (entry.isFile()) files.push(relative);
          else throw new Error('Folder contains an unsupported filesystem entry');
        }
        if (await realpath(`/proc/self/fd/${handle.fd}`)!==this.paths.absolute(current)) throw new Error('Folder moved during enumeration');
      } finally { await handle.close() }
    };
    await visit(path); return {directories,files};
  }

  /** Throws when the pinned parent of `path` has any entry. */
  async assertEmptyDirectory(path:string, message:string):Promise<void> {
    const parent = await this.paths.pinParent(path);
    try { if ((await readdir(parent.child)).length) throw new Error(message) } finally { await parent.handle.close() }
  }

  async restoreNoClobber(quarantine:string, source:string):Promise<void> {
    try { await this.link(quarantine, source) } catch (error:any) {
      if (error?.code !== 'EEXIST') throw error;
      // Both files remain preserved. The caller records an error for explicit reconciliation.
    }
  }

  async link(source:string, target:string):Promise<void> {
    const from = await this.paths.pinParent(source); const to = await this.paths.pinParent(target);
    try { await link(from.child, to.child); await to.handle.sync() } finally { await Promise.all([from.handle.close(), to.handle.close()]) }
  }

  /** Linux renameat2 is required: fs.rename can overwrite an unknown empty dir. */
  async renameNoReplace(source:string,target:string):Promise<void> {
    await this.requireAtomicRename();
    const from=await this.paths.pinParent(source); const to=await this.paths.pinParent(target);
    try {
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(PinnedFilesystemOperations.renameHelperPath,[basename(this.paths.absolute(source)),basename(this.paths.absolute(target))],
          {stdio:['ignore','ignore','pipe',from.handle.fd,to.handle.fd],env:{}});
        let errno='';
        child.stderr?.on('data',data=>{if (errno.length<32) errno+=String(data).slice(0,32)});
        child.once('error',()=>reject(new Error('Atomic no-clobber directory helper is unavailable')));
        child.once('close',code=>code===0?resolve():reject(new Error('Atomic no-clobber rename failed (errno '+errno.trim()+')')));
      });
      await to.handle.sync(); await from.handle.sync();
    } finally { await Promise.all([from.handle.close(),to.handle.close()]) }
  }

  async unlink(path:string,expected?:FileFingerprint):Promise<void> {
    const parent = await this.paths.pinParent(path);
    try {
      if (expected) {
        const entry=FileFingerprints.from(await lstat(parent.child,{bigint:true}));
        if (!FileFingerprints.sameFingerprint(entry,expected)) throw new Error('Directory entry identity changed before cleanup; replacement was preserved');
      }
      await unlink(parent.child); await parent.handle.sync();
    } finally { await parent.handle.close() }
  }
}
