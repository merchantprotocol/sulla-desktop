// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface DirectoryIdentity { device: string; inode: string }

/** Filesystem facts restore relies on: real directories, emptiness and (device, inode) identity. */
export class RestoreDirectories {
  static isWithin(parent:string, child:string):boolean {
    const value = relative(resolve(parent), resolve(child));
    return value === '' || (!value.startsWith('..') && !isAbsolute(value));
  }

  static sameIdentity(left:DirectoryIdentity, right:DirectoryIdentity):boolean {
    return left.device === right.device && left.inode === right.inode;
  }

  async isEmpty(path:string):Promise<boolean> {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Files restore target must be a real directory');
      return (await readdir(path)).length === 0;
    } catch (error:any) {
      if (error?.code === 'ENOENT') return true;
      throw error;
    }
  }

  async exists(path:string):Promise<boolean> {
    try { await lstat(path); return true } catch (error:any) { if (error?.code === 'ENOENT') return false; throw error }
  }

  async identity(path:string):Promise<DirectoryIdentity> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Files restore directory has an unsafe type');
    return { device: String(info.dev), inode: String(info.ino) };
  }
}
