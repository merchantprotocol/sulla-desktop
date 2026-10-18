import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SullaFilesPathResolution {
  canonicalPath: string;
  activePath: string;
  compatibility: 'canonical' | 'case-alias' | 'existing-uppercase';
}

function identity(value:string):{ dev:number; ino:number } | undefined {
  try { const info = fs.statSync(value); return { dev: info.dev, ino: info.ino } } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Selects a watched root without renaming, copying, or inspecting file contents. */
export function resolveSullaFilesUserRoot(home = os.homedir(), inspect:(value:string)=>{ dev:number; ino:number } | undefined = identity):SullaFilesPathResolution {
  const canonicalPath = path.join(home, 'sulla', 'files');
  const uppercasePath = path.join(home, 'sulla', 'Files');
  const canonical = inspect(canonicalPath); const uppercase = inspect(uppercasePath);
  if (canonical && canonical.dev === uppercase?.dev && canonical.ino === uppercase?.ino) return { canonicalPath, activePath: canonicalPath, compatibility: 'case-alias' };
  if (canonical && uppercase) throw new Error(`Sulla Files root is ambiguous: preserve both ${ canonicalPath } and ${ uppercasePath } until an explicit import is completed`);
  if (canonical) return { canonicalPath, activePath: canonicalPath, compatibility: 'canonical' };
  if (uppercase) return { canonicalPath, activePath: uppercasePath, compatibility: 'existing-uppercase' };
  return { canonicalPath, activePath: canonicalPath, compatibility: 'canonical' };
}
