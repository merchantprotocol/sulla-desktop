// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { statfs } from 'node:fs/promises';

// Bound the resident chunk cache independently of filesystem capacity.
export const DEFAULT_CACHE_MAX_BYTES = 20 * 1024 ** 3;

interface VolumeStats { blocks:number | bigint; bsize:number | bigint; bavail:number | bigint }

/** How many cached bytes must go: the excess over the cache cap, or enough to keep 10% of the volume free. */
export class ChunkCacheBudget {
  constructor(private readonly volume:(root:string) => Promise<VolumeStats> = statfs) {}

  static maximumBytes(value = process.env.SULLA_FILES_CACHE_MAX_BYTES):number {
    if (!value) return DEFAULT_CACHE_MAX_BYTES;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('SULLA_FILES_CACHE_MAX_BYTES must be a non-negative integer');
    return parsed;
  }

  async requiredEvictionBytes(root:string, residentBytes:number, maximum = ChunkCacheBudget.maximumBytes()):Promise<number> {
    const volume = await this.volume(root);
    const total = Number(volume.blocks) * Number(volume.bsize);
    const free = Number(volume.bavail) * Number(volume.bsize);
    const freeFloor = Math.ceil(total * 0.10);
    return Math.max(0, residentBytes - maximum, freeFloor - free);
  }
}

// Function exports kept for existing callers and specs.
export function cacheMaxBytes(value = process.env.SULLA_FILES_CACHE_MAX_BYTES):number { return ChunkCacheBudget.maximumBytes(value) }
export function requiredEvictionBytes(root:string, residentBytes:number, maximum = cacheMaxBytes()):Promise<number> {
  return new ChunkCacheBudget().requiredEvictionBytes(root, residentBytes, maximum);
}
