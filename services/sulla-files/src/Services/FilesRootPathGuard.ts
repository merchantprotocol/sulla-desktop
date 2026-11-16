// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { FileHandle } from 'node:fs/promises';

export interface PinnedParent { handle: FileHandle; child: string }

/**
 * Confines every Files mutation path to one native root. Paths must be relative, contain no
 * empty/"."/".." segment, and every parent is opened O_NOFOLLOW and re-checked through
 * /proc/self/fd so a symlink or concurrent rename cannot redirect the operation outside the root.
 */
export class FilesRootPathGuard {
  readonly root:string;
  private rootReady?: Promise<string>;

  constructor(root:string) {
    this.root = resolve(root);
  }

  ready():Promise<string> {
    if (!this.rootReady) {
      const pending = realpath(this.root);
      const retryable:Promise<string> = pending.catch((error) => {
        if (this.rootReady === retryable) this.rootReady = undefined;
        throw error;
      });
      this.rootReady = retryable;
    }
    return this.rootReady;
  }

  async exists(path:string):Promise<boolean> {
    let parent:PinnedParent;
    try { parent = await this.pinParent(path) } catch (error:any) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    try { await lstat(parent.child); return true } catch (error:any) { if (error?.code === 'ENOENT') return false; throw error } finally { await parent.handle.close() }
  }

  async ensurePrivateParent(path:string):Promise<void> {
    const clean = this.clean(path);
    if (!clean.startsWith('.sulla-trash/.residency/') && !clean.startsWith('.sulla-trash/.operations/')) {
      throw new Error('Private staging must stay under an owned Files recovery namespace');
    }
    await this.ensureParent(clean);
  }

  async ensureParent(path:string):Promise<void> {
    const parent = dirname(this.absolute(path));
    const root = await this.ready();
    const rel = relative(root, parent);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Files mutation parent escapes root');
    let current = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let expected = root;
    try {
      for (const part of rel.split(sep).filter(Boolean)) {
        const child = `/proc/self/fd/${ current.fd }/${ part }`;
        await mkdir(child, { mode: 0o700 }).catch((error:any) => { if (error?.code !== 'EEXIST') throw error; });
        await current.sync();
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

  async assertParentInsideRoot(path:string):Promise<void> {
    const parent = dirname(this.absolute(path));
    const root = await this.ready();
    const actual = await realpath(parent);
    if (actual !== parent || (actual !== root && !actual.startsWith(`${ root }${ sep }`))) throw new Error('Files mutation parent is not a stable directory under root');
  }

  async pinParent(path:string):Promise<PinnedParent> {
    const absolute = this.absolute(path);
    const parentPath = dirname(absolute);
    const root = await this.ready();
    const handle = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const actual = await realpath(`/proc/self/fd/${ handle.fd }`);
      if (actual !== parentPath || (actual !== root && !actual.startsWith(`${ root }${ sep }`))) {
        throw new Error('Pinned parent is not a stable directory under the Files root');
      }
      return { handle, child: `/proc/self/fd/${ handle.fd }/${ basename(absolute) }` };
    } catch (error) { await handle.close(); throw error }
  }

  async syncParent(path:string):Promise<void> {
    const parent = await this.pinParent(path);
    try { await parent.handle.sync() } finally { await parent.handle.close() }
  }

  absolute(path:string):string { return resolve(this.root, this.clean(path)) }

  clean(path:string):string {
    if (!path || isAbsolute(path)) throw new Error('Files mutation path must be relative');
    const clean = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (!clean || clean.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid Files mutation path');
    const absolute = resolve(this.root, clean);
    if (!absolute.startsWith(`${ this.root }${ sep }`)) throw new Error('Files mutation path escapes root');
    return clean;
  }
}
