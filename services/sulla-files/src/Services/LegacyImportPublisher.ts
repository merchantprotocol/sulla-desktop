// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LegacyImportPublicationRepository } from '../Repositories/LegacyImportPublicationRepository.js';
import type { LegacyImportCounts } from '../Repositories/LegacyImportReceiptRepository.js';
import type { LegacyImportTrace } from './LegacyImportTrace.js';
import type { LegacyKeyAuthority } from './LegacyKeyAuthority.js';
import type { ConvertedManifest } from './LegacyManifestConverter.js';
import type { LegacyStagedIdentity } from './LegacyVersionConverter.js';
import type pg from 'pg';

/**
 * Publishes converted legacy content into the native shadows inside the caller's
 * snapshot transaction, verifies provenance, then writes the completion receipt.
 * Any failure throws before the caller commits, so nothing is partially published.
 */
export class LegacyImportPublisher {
  constructor(private readonly repository:LegacyImportPublicationRepository, private readonly keys:LegacyKeyAuthority) {}

  async publish(client:pg.PoolClient, nativeMaster:Buffer, staged:LegacyStagedIdentity, versions:any[], converted:Map<string, ConvertedManifest>, trace:LegacyImportTrace):Promise<LegacyImportCounts> {
    trace.mark('manifest-publication');
    await this.publishManifests(client, staged, converted);
    trace.mark('file-publication');
    await this.repository.publishFiles(client);
    const versionMap = await this.repository.versionMap(client);
    const fileMap = await this.repository.fileMap(client);
    trace.mark('version-publication');
    for (const version of versions) {
      const manifest = version.manifest_hash ? converted.get(`${ version.chunk_collection_id }:${ version.manifest_hash }`) : undefined;
      const collection = staged.mappings.find(row => row.source_collection_id === version.chunk_collection_id);
      if (!collection || !versionMap.get(version.id) || !fileMap.get(version.file_id)) throw new Error('Legacy Files version identity mapping is incomplete');
      if (version.manifest_hash && !manifest) throw new Error('Legacy Files converted manifest is missing');
      await this.repository.insertShadowVersion(client, versionMap.get(version.id), fileMap.get(version.file_id), collection.shadow_collection_id, manifest?.hash ?? null, version);
      if (manifest) await this.repository.recordVerifiedVersion(client, version.id, manifest.hash, manifest.plaintextHash);
    }
    trace.mark('version-lineage-publication');
    for (const version of versions) {
      const parent = version.parent_version_id ? versionMap.get(version.parent_version_id) : null;
      const base = version.base_server_version_id ? versionMap.get(version.base_server_version_id) : null;
      if (version.parent_version_id && !parent) throw new Error('Legacy Files parent-version mapping is incomplete');
      if (version.base_server_version_id && !base) throw new Error('Legacy Files base-version mapping is incomplete');
      await this.repository.setLineage(client, versionMap.get(version.id), parent, base);
    }
    trace.mark('version-provenance-verification');
    await this.verifyProvenance(client, trace);
    trace.mark('current-version-publication');
    if (await this.repository.publishCurrentVersions(client)) throw new Error('Legacy Files current-version mapping is incomplete');
    trace.mark('access-publication');
    await this.repository.publishShares(client);
    trace.mark('graph-publication');
    await this.repository.publishEdges(client);
    trace.mark('journal-publication');
    await this.repository.publishJournal(client);
    trace.mark('audit-publication');
    for (const audit of await this.repository.unmappedAudits(client)) {
      if (audit.version_id && !audit.shadow_version_id) throw new Error('Legacy Files audit provenance mapping is incomplete');
      await this.repository.copyAudit(client, audit);
    }
    trace.mark('chunk-reference-publication');
    await this.repository.recountShadowChunkReferences(client);
    trace.mark('publication-verification');
    if (await this.repository.publicationIncomplete(client)) throw new Error('Legacy Files import verification is incomplete');
    await this.repository.complete(client);
    if (!await this.repository.hasKeyState(client)) await this.repository.insertKeyState(client, await this.keys.masterVerifier(nativeMaster));
    return { collections: staged.mappings.length, files: fileMap.size, versions: versionMap.size };
  }

  private async publishManifests(client:pg.PoolClient, staged:LegacyStagedIdentity, converted:Map<string, ConvertedManifest>):Promise<void> {
    for (const [key, manifest] of converted) {
      const sourceCollection = key.slice(0, key.indexOf(':')); const mapping = staged.mappings.find(row => row.source_collection_id === sourceCollection);
      if (!mapping) throw new Error('Legacy Files converted manifest has no collection mapping');
      const storedManifest = await this.repository.insertManifest(client, manifest.hash, manifest.ids, manifest.totalSize);
      if (!storedManifest || Number(storedManifest.total_size) !== manifest.totalSize || JSON.stringify(storedManifest.chunk_ids) !== JSON.stringify(manifest.ids)) throw new Error('Legacy Files manifest conflict does not match converted content');
      for (const [id, chunk] of manifest.chunks) {
        const location = `chunks/${ mapping.shadow_collection_id }/${ id }`;
        const storedChunk = await this.repository.insertChunk(client, mapping.shadow_collection_id, id, chunk.size, chunk.storedSize, location);
        if (!storedChunk || Number(storedChunk.size) !== chunk.size || Number(storedChunk.stored_size) !== chunk.storedSize || storedChunk.location !== location) throw new Error('Legacy Files chunk conflict does not match converted content');
      }
    }
  }

  private async verifyProvenance(client:pg.PoolClient, trace:LegacyImportTrace):Promise<void> {
    const versionConflict = await this.repository.versionConflicts(client);
    const versionConflicts = {
      fileMapping: Boolean(versionConflict.file_mapping),
      collectionMapping: Boolean(versionConflict.collection_mapping),
      manifestMapping: Boolean(versionConflict.manifest_mapping),
      parentMapping: Boolean(versionConflict.parent_mapping),
      baseMapping: Boolean(versionConflict.base_mapping),
      size: Boolean(versionConflict.size),
      deleted: Boolean(versionConflict.deleted),
      creatorType: Boolean(versionConflict.creator_type),
      creatorId: Boolean(versionConflict.creator_id),
      createdAt: Boolean(versionConflict.created_at),
      message: Boolean(versionConflict.message),
      deviceId: Boolean(versionConflict.device_id),
    };
    if (Object.values(versionConflicts).some(Boolean)) {
      trace.versionConflict(versionConflicts);
      throw new Error('Legacy Files version conflict does not match source provenance');
    }
  }
}
