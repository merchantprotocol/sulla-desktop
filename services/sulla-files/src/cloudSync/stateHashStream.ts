// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import type { StateEntry } from './envelope.js';

const line = (entry:StateEntry):string => `${ entry.fileId }:${ entry.versionId }:${ entry.deleted ? 1 : 0 }\n`;

/**
 * Byte-identical to envelope.stateHash(projected heads) without holding every head:
 * `pages` must yield heads ordered by fileId (files_cloud_file_heads keyset order), and
 * `overrides` (one commit or one pulled page, <= a few hundred) replace their file's head.
 * Memory is one page plus the overrides, independent of the collection's file count.
 */
export async function streamingStateHash(pages:AsyncIterable<StateEntry[]> | Iterable<StateEntry[]>, overrides:StateEntry[]):Promise<string> {
  const replaced = new Map<string, StateEntry>();
  for (const entry of overrides) replaced.set(entry.fileId, entry);
  const pending = [...replaced.values()].map(line).sort();
  const hash = createHash('sha256');
  let next = 0; let previous = '';
  for await (const page of pages) {
    for (const entry of page) {
      if (replaced.has(entry.fileId)) continue;
      const current = line(entry);
      // envelope.stateHash sorts lines; the stream must already be in that order.
      if (current < previous) throw new Error('cloud heads must be streamed in fileId order');
      previous = current;
      while (next < pending.length && pending[next] < current) hash.update(pending[next++]);
      hash.update(current);
    }
  }
  while (next < pending.length) hash.update(pending[next++]);
  return hash.digest('hex');
}

/** Wraps an in-memory list (tests, small callers) as a single sorted page. */
export function headsAsPages(entries:StateEntry[]):StateEntry[][] {
  return [[...entries].sort((left, right) => line(left) < line(right) ? -1 : line(left) > line(right) ? 1 : 0)];
}
