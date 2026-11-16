// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { TransactionRunner } from '../FilesTransaction.js';
import type { SystemAreaIngestRepository, SystemAreaQueryable } from '../Repositories/SystemAreaIngestRepository.js';

export interface MirroredSystemFile { id:string; current_version_id:string; unchanged:boolean }

export interface SystemAreaMirrorInput {
  collectionId:    string;
  path:            string;
  manifestHash:    string;
  skipSearchIndex: boolean;
}

export interface SystemAreaMirrorSteps {
  lockNamespace(client:SystemAreaQueryable, collectionId:string):Promise<void>;
  insertVersion(client:SystemAreaQueryable, existing?:{ id:string; current_version_id:string | null }):Promise<{ id:string; current_version_id:string }>;
}

/**
 * Plain, read-only mirroring of Desktop-owned system-area content (such as published Use Cases)
 * into Files. Creates no native-source rows, handles, publication planning or recovery state:
 * system areas are one-way inputs. An unchanged file (same manifest as its current version) is a
 * no-op, so a Desktop restart never creates new versions of unchanged files.
 *
 * The Logs collection is the Files service's internal audit store: never a mirroring target and
 * never search-indexed. The legacy skip-search header is accepted but cannot change that.
 */
export class SystemAreaMirror {
  static readonly skipSearchIndexHeader = 'x-sulla-files-skip-search-index';
  static readonly unindexedAreas:ReadonlySet<string> = new Set(['logs']);
  private static readonly mirroredAreas:ReadonlySet<string> = new Set(['sulla']);

  constructor(private readonly transactions:TransactionRunner, private readonly repository:SystemAreaIngestRepository) {}

  static isSystemArea(systemArea:unknown):boolean {
    return typeof systemArea === 'string' && SystemAreaMirror.mirroredAreas.has(systemArea);
  }

  static shouldSkipSearchIndex(_headerValue:string | undefined, systemArea:unknown):boolean {
    return typeof systemArea === 'string' && SystemAreaMirror.unindexedAreas.has(systemArea);
  }

  /**
   * Stores one system-area file. `insertVersion` writes the chunks/version (reusing `existing`
   * when the path already has a file); `lockNamespace` serialises namespace changes in the collection.
   */
  mirror(input:SystemAreaMirrorInput, steps:SystemAreaMirrorSteps):Promise<MirroredSystemFile> {
    return this.transactions.run('system-area-ingest', async client => {
      await steps.lockNamespace(client, input.collectionId);
      const existing = await this.repository.lockFileAtPath(client, input.collectionId, input.path);
      if (existing?.current_version_id && !existing.deleted_at && existing.manifest_hash === input.manifestHash) {
        return { id: existing.id, current_version_id: existing.current_version_id, unchanged: true };
      }
      const inserted = await steps.insertVersion(client, existing ? { id: existing.id, current_version_id: existing.current_version_id } : undefined);
      if (input.skipSearchIndex) await this.repository.skipSearchIndex(client, inserted.id, inserted.current_version_id);
      return { id: inserted.id, current_version_id: inserted.current_version_id, unchanged: false };
    });
  }
}
