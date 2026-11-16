// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SullaFilesPathResolution {
  canonicalPath: string;
  activePath: string;
  compatibility: 'canonical' | 'case-alias' | 'existing-uppercase';
}

export class SullaFilesPathsService {
  private readonly inspect:(value:string)=>{ dev:number; ino:number } | undefined;

  constructor(inspect:(value:string)=>{ dev:number; ino:number } | undefined = (value) => {
    try { const info = fs.statSync(value); return { dev: info.dev, ino: info.ino } } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }) { this.inspect = inspect; }

  /** Selects a watched root without renaming, copying, or inspecting file contents. */
  resolveUserRoot(home = os.homedir()):SullaFilesPathResolution {
    const canonicalPath = path.join(home, 'sulla', 'files');
    const uppercasePath = path.join(home, 'sulla', 'Files');
    const canonical = this.inspect(canonicalPath); const uppercase = this.inspect(uppercasePath);
    if (canonical && canonical.dev === uppercase?.dev && canonical.ino === uppercase.ino) return { canonicalPath, activePath: canonicalPath, compatibility: 'case-alias' };
    if (canonical && uppercase) throw new Error(`Sulla Files root is ambiguous: preserve both ${ canonicalPath } and ${ uppercasePath } until an explicit import is completed`);
    if (canonical) return { canonicalPath, activePath: canonicalPath, compatibility: 'canonical' };
    if (uppercase) return { canonicalPath, activePath: uppercasePath, compatibility: 'existing-uppercase' };
    return { canonicalPath, activePath: canonicalPath, compatibility: 'canonical' };
  }
}

export const sullaFilesPathsService = new SullaFilesPathsService();

/** Compatibility facade for the bootstrap process; new callers should inject the service. */
export function resolveSullaFilesUserRoot(home?:string, inspect?:(value:string)=>{ dev:number; ino:number } | undefined):SullaFilesPathResolution {
  return new SullaFilesPathsService(inspect).resolveUserRoot(home);
}
