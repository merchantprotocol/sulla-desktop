// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { statfs } from 'node:fs/promises';

export const DEFAULT_CACHE_MAX_BYTES = 20 * 1024 ** 3;

export function cacheMaxBytes(value = process.env.SULLA_FILES_CACHE_MAX_BYTES):number {
  if (!value) return DEFAULT_CACHE_MAX_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('SULLA_FILES_CACHE_MAX_BYTES must be a non-negative integer');
  return parsed;
}

export async function requiredEvictionBytes(root:string, residentBytes:number, maximum = cacheMaxBytes()):Promise<number> {
  const volume = await statfs(root);
  const total = Number(volume.blocks) * Number(volume.bsize);
  const free = Number(volume.bavail) * Number(volume.bsize);
  const freeFloor = Math.ceil(total * 0.10);
  return Math.max(0, residentBytes - maximum, freeFloor - free);
}
