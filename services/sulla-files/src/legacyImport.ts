// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { LegacyImportControlRepository } from './Repositories/LegacyImportControlRepository.js';
import { LegacyImportIdentityRepository } from './Repositories/LegacyImportIdentityRepository.js';
import { LegacyImportPublicationRepository } from './Repositories/LegacyImportPublicationRepository.js';
import { LegacyImportReceiptRepository, type LegacyImportCounts } from './Repositories/LegacyImportReceiptRepository.js';
import { LegacyImportStagingRepository } from './Repositories/LegacyImportStagingRepository.js';
import { LegacyChunkSource } from './Services/LegacyChunkSource.js';
import { LegacyImportContinuationRequiredError, LegacyImportDataError, LegacyImportFailurePolicy, LegacyImportTrace } from './Services/LegacyImportTrace.js';
import { LegacyImportPublisher } from './Services/LegacyImportPublisher.js';
import { LegacyKeyAuthority } from './Services/LegacyKeyAuthority.js';
import { LegacyManifestConverter, type LegacyKeys } from './Services/LegacyManifestConverter.js';
import { LegacyVersionConverter, type LegacyStagedIdentity } from './Services/LegacyVersionConverter.js';
import { Store } from './store.js';

import type pg from 'pg';

export { LegacyImportContinuationRequiredError, LegacyImportDataError } from './Services/LegacyImportTrace.js';

/** Collaborators of one importer; tests may swap any of them. */
export interface LegacyImportCollaborators {
  control:     LegacyImportControlRepository;
  staging:     LegacyImportStagingRepository;
  identity:    LegacyImportIdentityRepository;
  receipt:     LegacyImportReceiptRepository;
  chunks:      LegacyChunkSource;
  keys:        LegacyKeyAuthority;
  versions:    LegacyVersionConverter;
  publisher:   LegacyImportPublisher;
}

/**
 * Imports the retired runtime's Files data into native shadow collections, idempotently:
 * staging commits stable identity maps first, publication converts and publishes the whole
 * set in one snapshot transaction, and a completed receipt short-circuits later runs.
 */
export class LegacyFilesImporter {
  private readonly parts:LegacyImportCollaborators;

  constructor(private readonly db:pg.Pool, private readonly sourceRoot:string, private readonly chunkRoot:string, collaborators:Partial<LegacyImportCollaborators> = {}) {
    const control = collaborators.control ?? new LegacyImportControlRepository();
    const chunks = collaborators.chunks ?? new LegacyChunkSource();
    const keys = collaborators.keys ?? new LegacyKeyAuthority(control);
    this.parts = {
      control,
      chunks,
      keys,
      staging:   collaborators.staging ?? new LegacyImportStagingRepository(),
      identity:  collaborators.identity ?? new LegacyImportIdentityRepository(),
      receipt:   collaborators.receipt ?? new LegacyImportReceiptRepository(),
      versions:  collaborators.versions ?? new LegacyVersionConverter(new LegacyManifestConverter(chunks, new Store(chunkRoot))),
      publisher: collaborators.publisher ?? new LegacyImportPublisher(new LegacyImportPublicationRepository(), keys),
    };
  }

  async run(nativeMaster:Buffer, suppliedLegacyMasters:Buffer[]):Promise<LegacyImportCounts> {
    const trace = new LegacyImportTrace();
    try {
      if (nativeMaster.length !== 32 || suppliedLegacyMasters.some(key => key.length !== 32) || suppliedLegacyMasters.length === 0) throw new Error('Invalid Files import key material');
      trace.mark('completion-check');
      try {
        const completed = await this.completedResult();
        if (completed) { trace.completed(); return completed }
      } catch (error) {
        if (!(error instanceof LegacyImportContinuationRequiredError)) throw error;
      }
      const legacyMasters = suppliedLegacyMasters.map(value => Buffer.from(value));
      try {
        await this.stage(nativeMaster, trace);
        trace.mark('source-layout-scan');
        const externalLayout = await this.parts.chunks.optionalLayoutIds(this.sourceRoot);
        trace.mark('native-layout-scan');
        const nativeLayout = await this.parts.chunks.layoutIds(this.chunkRoot);
        return await this.publishSnapshot(nativeMaster, legacyMasters, externalLayout, nativeLayout, trace);
      } finally { for (const key of legacyMasters) key.fill(0); }
    } catch (error) {
      trace.failed(error instanceof LegacyImportDataError ? error.cause : error);
      if (error instanceof LegacyImportDataError) throw error;
      if (LegacyImportFailurePolicy.quarantinable(error)) throw new LegacyImportDataError(error);
      throw error;
    }
  }

  /**
   * Keeps failed legacy sources inaccessible while allowing unrelated native
   * collections to unlock. Original rows and ciphertext remain untouched for
   * later repair or export.
   */
  async containFailedSources():Promise<void> {
    const client = await this.db.connect();
    try {
      await this.parts.control.begin(client);
      await this.parts.control.lockImport(client);
      await this.parts.receipt.quarantineSources(client);
      await this.parts.control.commit(client);
    } catch (error) {
      await this.parts.control.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completedResult():Promise<LegacyImportCounts | undefined> {
    const client = await this.db.connect();
    const { control, receipt } = this.parts;
    try {
      await control.beginReadOnlySnapshot(client);
      if (!await receipt.isCompleted(client)) { await control.commit(client); return undefined }
      if (await receipt.sourceIdentityIncomplete(client)) throw new Error('Completed legacy Files import source identity changed or mapping is incomplete');
      const versionDrift = await receipt.versionDrift(client);
      if (versionDrift.count > 0) {
        if (versionDrift.continuable) throw new LegacyImportContinuationRequiredError('Completed legacy Files import has a safe linear version continuation');
        throw new Error('Completed legacy Files import version history changed or diverged');
      }
      const counts = await receipt.counts(client);
      await control.commit(client); return counts;
    } catch (error) { await control.rollback(client); throw error } finally { client.release() }
  }

  private async stage(nativeMaster:Buffer, trace:LegacyImportTrace):Promise<LegacyStagedIdentity> {
    const client = await this.db.connect();
    const { control, staging, keys } = this.parts;
    try {
      await control.begin(client);
      trace.mark('staging-lock');
      await control.lockImport(client);
      trace.mark('staging-master-verification');
      await keys.verifyNativeMaster(client, nativeMaster);
      trace.mark('staging-source-expansion');
      let expanded:number | null = 1;
      while (expanded) expanded = await staging.expandSources(client);
      const collections = await staging.lockSourceCollections(client);
      if (!collections.length) throw new Error('No legacy Files collections require import');
      trace.mark('staging-protection');
      await staging.protectSourceFiles(client);
      // A safe post-receipt continuation must revoke the completed receipt
      // before its identity-map changes commit. A crash then re-enters the
      // normal secure-import path instead of accepting partially published
      // continuation mappings as complete.
      await staging.markStaging(client);
      trace.mark('staging-collection-maps');
      for (const source of collections) {
        if (await staging.findCollectionMapping(client, source.id)) continue;
        const id = randomUUID();
        const wrapped = await keys.wrapNewCollectionKeys(nativeMaster, id);
        await staging.createShadowCollection(client, source.id, id, wrapped.data, wrapped.dedup);
      }
      const mappings = await staging.listCollectionMappings(client);
      trace.mark('staging-file-maps');
      await staging.mapFiles(client);
      trace.mark('staging-version-maps');
      await staging.mapVersions(client);
      await control.commit(client); return { collections, mappings };
    } catch (error) { await control.rollback(client); throw error } finally { client.release() }
  }

  /** Converts and publishes every staged identity in one REPEATABLE READ transaction. */
  private async publishSnapshot(nativeMaster:Buffer, legacyMasters:Buffer[], externalLayout:Map<string, string>, nativeLayout:Map<string, string>, trace:LegacyImportTrace):Promise<LegacyImportCounts> {
    const client = await this.db.connect();
    const { control, staging, identity, keys } = this.parts;
    try {
      await control.beginSnapshot(client);
      trace.mark('publish-lock');
      await control.lockImport(client);
      await control.lockPublicationTables(client);
      trace.mark('publish-master-verification');
      await keys.verifyNativeMaster(client, nativeMaster);
      trace.mark('publish-identity-verification');
      const collections = await staging.lockSourceCollections(client);
      const mappings = await staging.listCollectionMappings(client);
      if (collections.length !== mappings.length) throw new Error('Legacy Files collection mapping is incomplete');
      const staged = { collections, mappings };
      const externalIds = new Set(collections.filter(row => row.compatibility_state !== 'native').map(row => row.id.toLowerCase()));
      for (const id of externalLayout.keys()) if (!externalIds.has(id)) throw new Error('Legacy Files chunk collection has no authenticated metadata');
      await identity.mapLegacySourceFiles(client);
      await identity.mapVersions(client);
      if (await identity.identityIncomplete(client)) throw new Error('Legacy Files identity mapping is incomplete');
      const collectionKeys = new Map<string, LegacyKeys>(); const shadowKeys = new Map<string, LegacyKeys>();
      try {
        trace.mark('source-key-authentication');
        for (const collection of collections) {
          const nativeRow = await identity.collectionKeys(client, collection.id);
          trace.sourceKey({
            kind: collection.compatibility_state === 'native' ? 'native' : 'legacy',
            hasNativeKey: Boolean(nativeRow),
            hasExternalChunks: externalLayout.has(collection.id.toLowerCase()),
            hasNativeChunks: nativeLayout.has(collection.id.toLowerCase()),
          });
          collectionKeys.set(collection.id, await keys.sourceKeys(collection, nativeMaster, legacyMasters, nativeRow));
        }
        trace.mark('shadow-key-authentication');
        for (const mapping of mappings) {
          const row = await identity.collectionKeys(client, mapping.shadow_collection_id);
          if (!row) throw new Error('Legacy Files shadow collection key is unavailable');
          shadowKeys.set(mapping.source_collection_id, await keys.shadowKeys(row, nativeMaster, mapping.shadow_collection_id));
        }
        trace.mark('version-manifest-verification');
        const versions = await identity.mappedVersions(client);
        const converted = await this.parts.versions.convertAll(versions, {
          staged, collectionKeys, shadowKeys, externalLayout, nativeLayout, sourceRoot: this.sourceRoot, chunkRoot: this.chunkRoot,
        }, trace);
        const result = await this.parts.publisher.publish(client, nativeMaster, staged, versions, converted, trace);
        trace.mark('publication-commit');
        await control.commit(client);
        trace.completed();
        return result;
      } finally {
        for (const value of shadowKeys.values()) { value.data.fill(0); value.dedup.fill(0) }
        for (const value of collectionKeys.values()) { value.data.fill(0); value.dedup.fill(0) }
      }
    } catch (error) { await control.rollback(client); throw error } finally { client.release() }
  }
}
