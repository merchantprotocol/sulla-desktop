// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { LegacyPreflightRepository } from './Repositories/LegacyPreflightRepository.js';

import type { Dirent } from 'node:fs';
import type pg from 'pg';

export interface LegacyPreflightStatus {
  state:            'clear' | 'secure-import-required';
  protectedPrefix?: string;
  code?:            'FILES_LEGACY_SECURE_IMPORT_REQUIRED';
  action?:          string;
}

/** Metadata-only classification of the watched root. No legacy key or chunk content is opened. */
export class LegacyPreflightService {
  private static readonly UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  private static readonly BUCKET = /^[0-9a-f]{2}$/i;
  private static readonly CHUNK = /^[0-9a-f]{64}$/i;

  constructor(private readonly repository:LegacyPreflightRepository) {}

  static isLegacyInternalPath(path:string, status?:LegacyPreflightStatus):boolean {
    if (!status?.protectedPrefix) return false;
    const normalized = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
    const prefix = status.protectedPrefix.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
    return normalized === prefix || normalized.startsWith(`${ prefix }/`);
  }

  async run(filesRoot:string, options:{ caseInsensitive?: boolean } = {}):Promise<LegacyPreflightStatus> {
    const repository = this.repository;
    await repository.classifyExternalCollections();
    const previous = await repository.previous();
    const caseInsensitive = options.caseInsensitive ?? false;
    const entries = await this.rootEntries(filesRoot);
    const chunksEntry = this.rootEntry(entries, 'chunks', caseInsensitive);
    const masterEntry = this.rootEntry(entries, 'master.key', caseInsensitive);
    const chunksName = chunksEntry?.isDirectory() ? chunksEntry.name : undefined;
    const masterName = masterEntry?.isFile() ? masterEntry.name : undefined;
    const externalIds = await repository.externalCollectionIds();
    const chunksRoot = chunksName ? join(filesRoot, chunksName) : '';
    let masterMarker = false;
    if (masterName) {
      try {
        const info = await lstat(join(filesRoot, masterName));
        masterMarker = info.isFile() && !info.isSymbolicLink() && info.size === 32;
      } catch (error) {
        throw new Error('Legacy Files preflight could not verify master-key metadata', { cause: error });
      }
    }
    // The retired runtime's exact root-level UUID/bucket/hash shape is itself
    // containment evidence. Its master may already be in OS custody/quarantine,
    // and its collection ids may never have reached this database.
    const layoutIds = chunksName ? await this.legacyChunkCollections(chunksRoot) : [];
    const published = await repository.publishedSourceCollectionIds();
    const completed = await repository.importCompleted();
    const unresolved = externalIds.some(id => !published.includes(id)) || layoutIds.some(id => !published.includes(id));
    const detected = layoutIds.length > 0 || externalIds.length > 0 || Boolean(masterMarker && chunksName);
    const required = unresolved || (!completed && (detected || previous?.state === 'secure-import-required'));
    // Retain the prefix after conversion: the original ciphertext remains an
    // immutable recovery source and must never enter watcher/search/share paths.
    const protectedPrefix = previous?.protected_prefix || (detected ? chunksName || 'chunks' : undefined);
    await repository.record(required, protectedPrefix);
    if (required && protectedPrefix) await repository.protectWatchedPrefix(protectedPrefix);
    return required
      ? {
        state:  'secure-import-required',
        protectedPrefix,
        code:   'FILES_LEGACY_SECURE_IMPORT_REQUIRED',
        action: 'Legacy Files data is preserved in place and contained. Secure import/recovery is required before it can be opened.',
      }
      : { state: 'clear' };
  }

  private async rootEntries(root:string):Promise<Dirent[]> {
    try { return await readdir(root, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Legacy Files preflight could not inspect the watched-root metadata', { cause: error });
    }
  }

  private rootEntry(entries:Dirent[], expected:string, caseInsensitive:boolean):Dirent | undefined {
    const matches = entries.filter(item => caseInsensitive ? item.name.toLowerCase() === expected.toLowerCase() : item.name === expected);
    if (matches.length > 1) throw new Error(`Legacy Files preflight found ambiguous ${ expected } root metadata`);
    return matches[0];
  }

  private async legacyChunkCollections(chunksRoot:string):Promise<string[]> {
    let collections;
    try { collections = await readdir(chunksRoot, { withFileTypes: true }) } catch (error) {
      throw new Error('Legacy Files preflight could not inspect chunk-store metadata', { cause: error });
    }
    const found:string[] = [];
    for (const collection of collections) {
      const id = collection.name.toLowerCase();
      if (!collection.isDirectory() || !LegacyPreflightService.UUID.test(id)) continue;
      let buckets;
      try { buckets = await readdir(join(chunksRoot, collection.name), { withFileTypes: true }) } catch (error) {
        throw new Error('Legacy Files preflight could not inspect collection metadata', { cause: error });
      }
      for (const bucket of buckets) {
        if (!bucket.isDirectory() || !LegacyPreflightService.BUCKET.test(bucket.name)) continue;
        let chunks;
        try { chunks = await readdir(join(chunksRoot, collection.name, bucket.name), { withFileTypes: true }) } catch (error) {
          throw new Error('Legacy Files preflight could not inspect bucket metadata', { cause: error });
        }
        if (chunks.some(chunk => chunk.isFile() && LegacyPreflightService.CHUNK.test(chunk.name))) { found.push(id); break }
      }
    }
    return found;
  }
}

/** @deprecated Use `new LegacyPreflightService(new LegacyPreflightRepository(db)).run(...)`; kept for index.ts/lifecycle.ts. */
export function runLegacyPreflight(db:pg.Pool, filesRoot:string, options:{ caseInsensitive?: boolean } = {}):Promise<LegacyPreflightStatus> {
  return new LegacyPreflightService(new LegacyPreflightRepository(db)).run(filesRoot, options);
}

/** @deprecated Use `LegacyPreflightService.isLegacyInternalPath`; kept for localManager.ts. */
export function isLegacyInternalPath(path:string, status?:LegacyPreflightStatus):boolean {
  return LegacyPreflightService.isLegacyInternalPath(path, status);
}
