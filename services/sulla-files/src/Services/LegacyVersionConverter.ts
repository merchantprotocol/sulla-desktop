// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { LegacyChunkSource } from './LegacyChunkSource.js';
import { LegacyImportDataError } from './LegacyImportTrace.js';

import type { LegacyCollectionMapping, LegacySourceCollection } from '../Repositories/LegacyImportStagingRepository.js';
import type { LegacyImportTrace } from './LegacyImportTrace.js';
import type { ConvertedManifest, LegacyKeys, LegacyManifestConverter } from './LegacyManifestConverter.js';

export interface LegacyStagedIdentity { collections: LegacySourceCollection[]; mappings: LegacyCollectionMapping[] }

export interface LegacyConversionContext {
  staged:         LegacyStagedIdentity;
  collectionKeys: Map<string, LegacyKeys>;
  shadowKeys:     Map<string, LegacyKeys>;
  externalLayout: Map<string, string>;
  nativeLayout:   Map<string, string>;
  /** The retired external chunk tree. */
  sourceRoot:     string;
  /** The native chunk store root. */
  chunkRoot:      string;
}

/**
 * Authenticates every mapped version's source manifest and converts each distinct
 * (chunk collection, manifest) pair exactly once. Keyed `<chunk collection>:<manifest hash>`.
 */
export class LegacyVersionConverter {
  constructor(private readonly manifests:LegacyManifestConverter) {}

  async convertAll(versions:any[], context:LegacyConversionContext, trace:LegacyImportTrace):Promise<Map<string, ConvertedManifest>> {
    const converted = new Map<string, ConvertedManifest>();
    for (const version of versions) {
      if (!version.manifest_hash) continue;
      if (!Array.isArray(version.chunk_ids)) throw new Error('Legacy Files version manifest is missing');
      const sourceIds = version.chunk_ids.map((id:unknown) => LegacyChunkSource.validId(String(id), LegacyChunkSource.CHUNK, 'chunk'));
      const totalSize = Number(version.total_size);
      if (!Number.isSafeInteger(totalSize) || totalSize < 0 || totalSize !== Number(version.size)) throw new Error('Legacy Files version size verification failed');
      const sourceManifestHash = createHash('sha256').update(JSON.stringify({ ids: sourceIds, size: totalSize })).digest('hex');
      if (sourceManifestHash !== version.manifest_hash) throw new Error('Legacy Files source manifest authentication failed');
      const key = `${ version.chunk_collection_id }:${ version.manifest_hash }`;
      if (!converted.has(key)) {
        converted.set(key, await this.convertOne(version, sourceIds, totalSize, context, trace));
        trace.mark('version-manifest-verification');
      }
      if (converted.get(key)!.totalSize !== totalSize) throw new Error('Legacy Files version size verification failed');
    }
    return converted;
  }

  private async convertOne(version:any, sourceIds:string[], totalSize:number, context:LegacyConversionContext, trace:LegacyImportTrace):Promise<ConvertedManifest> {
    const source = context.collectionKeys.get(version.chunk_collection_id); const shadow = context.shadowKeys.get(version.chunk_collection_id);
    const mapping = context.staged.mappings.find(row => row.source_collection_id === version.chunk_collection_id);
    if (!source || !shadow || !mapping) throw new Error('Legacy Files version references an unmapped chunk collection');
    const sourceCollection = context.staged.collections.find(row => row.id === version.chunk_collection_id);
    if (!sourceCollection) throw new Error('Legacy Files version references a missing source collection');
    const externalName = context.externalLayout.get(version.chunk_collection_id.toLowerCase());
    const nativeName = context.nativeLayout.get(version.chunk_collection_id.toLowerCase());
    if (sourceCollection.compatibility_state !== 'native' && externalName && nativeName) throw new Error('Legacy Files manifested collection has ambiguous source layouts');
    if (sourceCollection.compatibility_state !== 'native' && !externalName && !nativeName) throw new Error('Legacy Files manifested collection has no exact source layout');
    const nativeSource = sourceCollection.compatibility_state === 'native' || !externalName;
    const sourceRoot = nativeSource ? context.chunkRoot : context.sourceRoot;
    const collectionId = nativeSource ? nativeName ?? version.chunk_collection_id : externalName!;
    trace.mark('chunk-conversion');
    try {
      return await this.manifests.convert({ collectionId, chunkIds: sourceIds, totalSize, sourceRoot, sourceKeys: source, shadowKeys: shadow, shadowCollectionId: mapping.shadow_collection_id });
    } catch (error) {
      // Chunk reads, authentication, identity, and size checks are
      // scoped to this legacy manifest. Their failure must contain
      // the item, not lock unrelated Files collections.
      throw new LegacyImportDataError(error);
    }
  }
}
