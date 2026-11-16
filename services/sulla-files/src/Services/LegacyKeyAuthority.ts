// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, timingSafeEqual } from 'node:crypto';

import { decrypt, encrypt, type Envelope } from '../crypto.js';

import type { LegacyImportControlRepository } from '../Repositories/LegacyImportControlRepository.js';
import type { LegacyWrappedCollectionKeys } from '../Repositories/LegacyImportIdentityRepository.js';
import type { LegacySourceCollection } from '../Repositories/LegacyImportStagingRepository.js';
import type { LegacyKeys } from './LegacyManifestConverter.js';
import type pg from 'pg';

/** Verifies the native master and unwraps source/shadow collection keys for the legacy import. */
export class LegacyKeyAuthority {
  static readonly MASTER_CONTEXT = 'sulla:files:master-check:v1';
  static readonly MASTER_CHECK = Buffer.from('sulla-files-keychain-master-v1');

  constructor(private readonly control:LegacyImportControlRepository) {}

  static dataContext(collectionId:string):string { return `sulla:files:data-key:v1:${ collectionId }` }
  static dedupContext(collectionId:string):string { return `sulla:files:dedup-key:v1:${ collectionId }` }

  /** Locks the verifier row; a database without one has never been keyed and accepts any 32-byte master. */
  async verifyNativeMaster(client:pg.PoolClient, master:Buffer):Promise<void> {
    if (master.length !== 32) throw new Error('Invalid Files master key');
    const verifier = await this.control.lockedMasterVerifier(client);
    if (!verifier) return;
    const check = Buffer.from(await decrypt(verifier, master, LegacyKeyAuthority.MASTER_CONTEXT));
    try { if (check.length !== LegacyKeyAuthority.MASTER_CHECK.length || !timingSafeEqual(check, LegacyKeyAuthority.MASTER_CHECK)) throw new Error('Invalid Files master key'); } finally { check.fill(0) }
  }

  masterVerifier(master:Buffer):Promise<Envelope> {
    return encrypt(LegacyKeyAuthority.MASTER_CHECK, master, LegacyKeyAuthority.MASTER_CONTEXT);
  }

  /** Fresh random collection keys wrapped by the native master; plaintext keys are zeroed before returning. */
  async wrapNewCollectionKeys(nativeMaster:Buffer, collectionId:string):Promise<{ data: Envelope; dedup: Envelope }> {
    const data = randomBytes(32); const dedup = randomBytes(32);
    try {
      return { data: await encrypt(data, nativeMaster, LegacyKeyAuthority.dataContext(collectionId)), dedup: await encrypt(dedup, nativeMaster, LegacyKeyAuthority.dedupContext(collectionId)) };
    } finally { data.fill(0); dedup.fill(0) }
  }

  async unwrap(envelope:Envelope, key:Buffer, context:string):Promise<Buffer> {
    const value = Buffer.from(await decrypt(envelope, key, context));
    if (value.length !== 32) { value.fill(0); throw new Error('Invalid legacy collection key') }
    return value;
  }

  /** A native shadow's keys, wrapped by the native master. */
  async shadowKeys(row:LegacyWrappedCollectionKeys, nativeMaster:Buffer, shadowCollectionId:string):Promise<LegacyKeys> {
    return {
      data:  await this.unwrap(row.data_key, nativeMaster, LegacyKeyAuthority.dataContext(shadowCollectionId)),
      dedup: await this.unwrap(row.dedup_key, nativeMaster, LegacyKeyAuthority.dedupContext(shadowCollectionId)),
    };
  }

  /**
   * A source collection's keys: native rows unwrap with the native master; external rows
   * must authenticate under exactly one distinct retired master.
   */
  async sourceKeys(collection:LegacySourceCollection, nativeMaster:Buffer, legacyMasters:Buffer[], nativeRow?:LegacyWrappedCollectionKeys):Promise<LegacyKeys> {
    if (collection.compatibility_state === 'native') {
      if (!nativeRow) throw new Error('Native source collection key is unavailable');
      const data = await this.unwrap(nativeRow.data_key, nativeMaster, LegacyKeyAuthority.dataContext(collection.id));
      try { return { data, dedup: await this.unwrap(nativeRow.dedup_key, nativeMaster, LegacyKeyAuthority.dedupContext(collection.id)) } } catch (error) { data.fill(0); throw error }
    }
    const matches:LegacyKeys[] = [];
    for (const master of legacyMasters) {
      try {
        const data = await this.unwrap(collection.encrypted_data_key, master, LegacyKeyAuthority.dataContext(collection.id));
        try { matches.push({ data, dedup: await this.unwrap(collection.dedup_key_ciphertext, master, LegacyKeyAuthority.dedupContext(collection.id)) }) } catch { data.fill(0) }
      } catch { /* A candidate may belong to another retired store. */ }
    }
    const unique = matches.filter((candidate, index) => matches.findIndex(other => timingSafeEqual(candidate.data, other.data) && timingSafeEqual(candidate.dedup, other.dedup)) === index);
    for (const candidate of matches) if (!unique.includes(candidate)) { candidate.data.fill(0); candidate.dedup.fill(0) }
    if (unique.length !== 1) {
      for (const candidate of unique) { candidate.data.fill(0); candidate.dedup.fill(0) }
      throw new Error(unique.length === 0
        ? 'Legacy Files collection key authentication found no protected master'
        : 'Legacy Files collection key authentication found ambiguous protected masters');
    }
    return unique[0];
  }
}
