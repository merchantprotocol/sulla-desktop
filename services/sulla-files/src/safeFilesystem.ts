import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';

export interface FileFingerprint { dev: bigint; ino: bigint; size: number; mtimeMs: number }
export interface EvictionReceipt { source: string; quarantine: string; fingerprint: FileFingerprint }
export interface PublicationReceipt { staged: string; target: string; fingerprint: FileFingerprint }

export class PinnedRegularFile {
  constructor(
    readonly relativePath:string,
    readonly fingerprint:FileFingerprint,
    private readonly handle:FileHandle,
  ) {}

  createReadStream(highWaterMark = 4 * 1024 * 1024):Readable {
    return this.handle.createReadStream({ autoClose: false, highWaterMark, start: 0 });
  }

  async assertUnchanged():Promise<void> {
    const current = fingerprint(await this.handle.stat({ bigint: true }));
    if (!sameFingerprint(current, this.fingerprint)) throw new Error('Pinned file changed during operation');
  }

  async close():Promise<void> { await this.handle.close() }
}

type Verify = (pinned:PinnedRegularFile)=>Promise<void>;

/**
 * One coordinator must be shared by the watcher, file operations, and
 * residency. The queue is intentionally global: overlapping directory/file
 * operations cannot be proven independent after a concurrent rename.
 */
export class FilesMutationCoordinator {
  private tail:               Promise<void> = Promise.resolve();
  private readonly scope = new AsyncLocalStorage<boolean>();
  private readonly rootReady: Promise<string>;

  constructor(private readonly root:string) {
    this.root = resolve(root);
    this.rootReady = realpath(this.root);
  }

  runExclusive<T>(_relativePaths:string[], operation:()=>Promise<T>):Promise<T> {
    if (this.scope.getStore()) return operation();
    const result = this.tail.then(() => this.scope.run(true, operation));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  evictVerified(input:{ source: string; quarantine: string; verify: Verify }):Promise<EvictionReceipt> {
    return this.runExclusive([input.source, input.quarantine], async() => {
      const source = await this.pinVerified(input.source, input.verify);
      try {
        await this.ensurePrivateParent(input.quarantine);
        if (await this.exists(input.quarantine)) throw new Error('Eviction quarantine already exists');
        await this.renamePinned(input.source, input.quarantine);
        const moved = await this.pinVerified(input.quarantine, input.verify);
        try {
          if (!sameIdentity(source.fingerprint, moved.fingerprint)) {
            await this.restoreNoClobber(input.quarantine, input.source);
            throw new Error('Source identity changed during atomic eviction');
          }
          return { source: input.source, quarantine: input.quarantine, fingerprint: moved.fingerprint };
        } finally { await moved.close() }
      } finally { await source.close() }
    });
  }

  publishVerified(input:{ staged: string; target: string; verify: Verify }):Promise<PublicationReceipt> {
    return this.runExclusive([input.staged, input.target], async() => {
      const staged = await this.pinVerified(input.staged, input.verify);
      try {
        await this.ensureParent(input.target);
        try { await this.linkPinned(input.staged, input.target) } catch (error:any) {
          if (error?.code === 'EEXIST') throw new Error('Publication will not overwrite an existing file');
          throw error;
        }
        const target = await this.pinVerified(input.target, input.verify);
        try {
          if (!sameIdentity(staged.fingerprint, target.fingerprint)) throw new Error('Published file identity does not match its pinned stage');
          return { staged: input.staged, target: input.target, fingerprint: target.fingerprint };
        } finally { await target.close() }
      } finally { await staged.close() }
    });
  }

  copyVerified(input:{ source: string; target: string; verify: Verify; staged?: string }):Promise<PublicationReceipt> {
    return this.runExclusive([input.source, input.target], async() => {
      const source = await this.pinVerified(input.source, input.verify);
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
        if (await this.exists(staged).catch(() => false)) await this.unlinkPinned(staged).catch(() => undefined);
        throw error;
      } finally { await source.close() }
    });
  }

  async recoverEviction(receipt:EvictionReceipt, verify:Verify):Promise<void> {
    await this.runExclusive([receipt.source, receipt.quarantine], async() => {
      const quarantine = await this.pinVerified(receipt.quarantine, verify);
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
          await this.unlinkPinned(receipt.quarantine);
          return;
        }
        await this.ensureParent(receipt.source);
        await this.linkPinned(receipt.quarantine, receipt.source);
        const restored = await this.pinVerified(receipt.source, verify);
        try {
          if (!sameIdentity(restored.fingerprint, receipt.fingerprint)) throw new Error('Restored source identity does not match eviction receipt');
        } finally { await restored.close() }
        await this.unlinkPinned(receipt.quarantine);
      } finally { await quarantine.close() }
    });
  }

  async rollbackPublication(receipt:PublicationReceipt, verify:Verify):Promise<void> {
    await this.runExclusive([receipt.staged, receipt.target], async() => {
      const target = await this.pin(receipt.target);
      const rollback = `.sulla-trash/.residency/${ randomUUID() }.rollback`;
      try {
        if (!sameFingerprint(target.fingerprint, receipt.fingerprint)) throw new Error('Published target changed before rollback');
        await verify(target);
        await target.assertUnchanged();
        await this.ensurePrivateParent(rollback);
        if (!await this.exists(receipt.staged)) await this.linkPinned(receipt.target, receipt.staged);
        const staged = await this.pinVerified(receipt.staged, verify);
        try {
          if (!sameIdentity(staged.fingerprint, receipt.fingerprint)) throw new Error('Rollback stage does not match the published target');
        } finally { await staged.close() }
        await this.renamePinned(receipt.target, rollback);
        const moved = await this.pinVerified(rollback, verify);
        try {
          if (!sameIdentity(moved.fingerprint, receipt.fingerprint)) {
            await this.restoreNoClobber(rollback, receipt.target);
            throw new Error('Published target was replaced during rollback; replacement was preserved');
          }
        } finally { await moved.close() }
        await this.unlinkPinned(rollback);
      } finally { await target.close() }
    });
  }

  async openPrivateExclusive(path:string):Promise<FileHandle> {
    await this.ensurePrivateParent(path);
    const parent = await this.pinParent(path);
    try { return await open(parent.child, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600) } finally { await parent.handle.close() }
  }

  async finalizePublication(receipt:PublicationReceipt | EvictionReceipt):Promise<void> {
    const staged = 'staged' in receipt ? receipt.staged : receipt.quarantine;
    await this.runExclusive([staged], async() => {
      const pinned = await this.pin(staged);
      try {
        if (!sameIdentity(pinned.fingerprint, receipt.fingerprint)) throw new Error('Private staged identity changed before cleanup');
      } finally { await pinned.close() }
      await this.unlinkPinned(staged);
    });
  }

  async pinVerified(path:string, verify:Verify):Promise<PinnedRegularFile> {
    const pinned = await this.pin(path);
    try { await verify(pinned); await pinned.assertUnchanged(); return pinned } catch (error) { await pinned.close(); throw error }
  }

  async pin(path:string):Promise<PinnedRegularFile> {
    await this.assertParentInsideRoot(path);
    const parent = await this.pinParent(path);
    const handle = await open(parent.child, constants.O_RDONLY | constants.O_NOFOLLOW).finally(() => parent.handle.close());
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) throw new Error('Files mutation target must be a regular file');
      const actual = await realpath(`/proc/self/fd/${ handle.fd }`).catch(() => '');
      const root = await this.rootReady;
      if (!actual || (actual !== root && !actual.startsWith(`${ root }${ sep }`))) throw new Error('Pinned file escaped the Files root');
      return new PinnedRegularFile(this.clean(path), fingerprint(stats), handle);
    } catch (error) { await handle.close(); throw error }
  }

  exists(path:string):Promise<boolean> {
    return this.pinParent(path).then(async parent => {
      try { await lstat(parent.child); return true } catch (error:any) { if (error?.code === 'ENOENT') return false; throw error } finally { await parent.handle.close() }
    });
  }

  private async restoreNoClobber(quarantine:string, source:string):Promise<void> {
    try { await this.linkPinned(quarantine, source) } catch (error:any) {
      if (error?.code !== 'EEXIST') throw error;
      // Both files remain preserved. The caller records an error for explicit reconciliation.
    }
  }

  private async ensurePrivateParent(path:string):Promise<void> {
    const clean = this.clean(path);
    if (!clean.startsWith('.sulla-trash/.residency/') && !clean.startsWith('.sulla-trash/.operations/')) {
      throw new Error('Private staging must stay under an owned Files recovery namespace');
    }
    await this.ensureParent(clean);
  }

  private async ensureParent(path:string):Promise<void> {
    const parent = dirname(this.absolute(path));
    const root = await this.rootReady;
    const rel = relative(root, parent);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Files mutation parent escapes root');
    let current = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let expected = root;
    try {
      for (const part of rel.split(sep).filter(Boolean)) {
        const child = `/proc/self/fd/${ current.fd }/${ part }`;
        await mkdir(child, { mode: 0o700 }).catch((error:any) => { if (error?.code !== 'EEXIST') throw error; });
        const next = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        expected = resolve(expected, part);
        try {
          if (await realpath(`/proc/self/fd/${ next.fd }`) !== expected) throw new Error('Files mutation parent changed during traversal');
        } catch (error) { await next.close(); throw error }
        await current.close();
        current = next;
      }
    } finally {
      await current.close();
    }
  }

  private async assertParentInsideRoot(path:string):Promise<void> {
    const parent = dirname(this.absolute(path));
    const root = await this.rootReady;
    const actual = await realpath(parent);
    if (actual !== parent || (actual !== root && !actual.startsWith(`${ root }${ sep }`))) throw new Error('Files mutation parent is not a stable directory under root');
  }

  private async pinParent(path:string):Promise<{ handle: FileHandle; child: string }> {
    const absolute = this.absolute(path);
    const parentPath = dirname(absolute);
    const root = await this.rootReady;
    const handle = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const actual = await realpath(`/proc/self/fd/${ handle.fd }`);
      if (actual !== parentPath || (actual !== root && !actual.startsWith(`${ root }${ sep }`))) {
        throw new Error('Pinned parent is not a stable directory under the Files root');
      }
      return { handle, child: `/proc/self/fd/${ handle.fd }/${ basename(absolute) }` };
    } catch (error) { await handle.close(); throw error }
  }

  private async linkPinned(source:string, target:string):Promise<void> {
    const from = await this.pinParent(source); const to = await this.pinParent(target);
    try { await link(from.child, to.child) } finally { await Promise.all([from.handle.close(), to.handle.close()]) }
  }

  private async renamePinned(source:string, target:string):Promise<void> {
    const from = await this.pinParent(source); const to = await this.pinParent(target);
    try { await rename(from.child, to.child) } finally { await Promise.all([from.handle.close(), to.handle.close()]) }
  }

  private async unlinkPinned(path:string):Promise<void> {
    const parent = await this.pinParent(path);
    try { await unlink(parent.child) } finally { await parent.handle.close() }
  }

  private absolute(path:string):string { return resolve(this.root, this.clean(path)) }
  private clean(path:string):string {
    if (!path || isAbsolute(path)) throw new Error('Files mutation path must be relative');
    const clean = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (!clean || clean.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid Files mutation path');
    const absolute = resolve(this.root, clean);
    if (!absolute.startsWith(`${ this.root }${ sep }`)) throw new Error('Files mutation path escapes root');
    return clean;
  }
}

function fingerprint(stats:{ dev: bigint; ino: bigint; size: bigint; mtimeMs: bigint }):FileFingerprint {
  const size = Number(stats.size); const mtimeMs = Number(stats.mtimeMs);
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtimeMs)) throw new Error('File metadata exceeds safe bounds');
  return { dev: stats.dev, ino: stats.ino, size, mtimeMs };
}
function sameIdentity(left:FileFingerprint, right:FileFingerprint):boolean { return left.dev === right.dev && left.ino === right.ino }
function sameFingerprint(left:FileFingerprint, right:FileFingerprint):boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
