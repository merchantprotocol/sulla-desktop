// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

const TEMP_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;
export const MAC_LOCAL_TEMP_FALLBACK = '/private/tmp';

function isExternalVolume(candidate: string): boolean {
  const absolute = path.resolve(candidate);

  return absolute === '/Volumes' || absolute.startsWith('/Volumes/');
}

function usableDirectory(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isDirectory()) return false;
    fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep Desktop and every child process off removable macOS volumes and invalid
 * inherited temp directories. Valid local per-user temp paths remain untouched.
 */
export function ensureReliableTempEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isUsable: (candidate: string) => boolean = usableDirectory,
): boolean {
  if (platform !== 'darwin') return false;

  let changed = false;
  for (const key of TEMP_KEYS) {
    const candidate = env[key]?.trim();
    if (!candidate || (!isExternalVolume(candidate) && isUsable(candidate))) continue;
    env[key] = MAC_LOCAL_TEMP_FALLBACK;
    changed = true;
  }

  return changed;
}
