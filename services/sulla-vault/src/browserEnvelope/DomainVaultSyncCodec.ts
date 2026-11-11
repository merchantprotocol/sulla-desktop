// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  DefaultVaultRecordCodec,
  KeyWrap,
  VaultBundleDtoSchema,
  VaultHeadDtoSchema,
  VaultRecordDtoSchema,
  VaultSyncCodec,
  type CryptoPrimitives,
  type RandomSource,
  type VaultBundle,
  type VaultHead,
  type VaultRecord,
} from '@sulla/domain';
import { EnvelopeError, type BundleFields, type RecordFields, type SyncBundle, type SyncHead, type SyncItem, type SyncRecord } from './envelope.js';

/** Anything with a Zod-style `safeParse`, which is how the domain DTO schemas are used. */
interface ShapeSchema { safeParse(value: unknown): { success: boolean } }

/** Desktop runtime adapter for the shared vault-sync-v3 domain codec. Every AAD string lives in the domain codec. */
export class DomainVaultSyncCodec {
  private readonly codec: VaultSyncCodec;
  private readonly crypto: CryptoPrimitives;
  private readonly random: RandomSource;

  constructor(crypto: CryptoPrimitives, random: RandomSource) {
    this.codec = new VaultSyncCodec(crypto, new KeyWrap(crypto, random));
    this.crypto = crypto;
    this.random = random;
  }

  deriveMacKey(scopeKey: Uint8Array): Uint8Array {
    return this.codec.deriveMacKey(scopeKey);
  }

  buildBundle(fields: BundleFields, userKey: Uint8Array): SyncBundle {
    const body = { format: 'sulla-vault-sync-bundle', v: fields.recovery ? 2 : 1, ...fields } as Omit<VaultBundle, 'mac'>;
    const result = this.codec.sealBundle(body, userKey) as SyncBundle;
    this.assertShape(VaultBundleDtoSchema, result, 'bundle');
    return result;
  }

  verifyBundle(bundle: unknown, userKey: Uint8Array): void {
    this.assertShape(VaultBundleDtoSchema, bundle, 'bundle');
    this.codec.verifyBundle(bundle as VaultBundle, userKey);
  }

  unlockBundle(bundle: unknown, password: string): Uint8Array {
    this.assertShape(VaultBundleDtoSchema, bundle, 'bundle');
    return this.codec.unlockBundle(bundle as VaultBundle, password);
  }

  buildRecord(fields: RecordFields, scopeKey: Uint8Array): SyncRecord {
    const record = {
      format: 'sulla-vault-sync-record', v: 1, vaultId: fields.vaultId, scope: fields.scope,
      kind: fields.kind, id: fields.id, generation: fields.generation, deleted: Boolean(fields.deleted),
      ...(!fields.deleted && fields.kind === 'item' ? { item: fields.item } : {}),
      ...(!fields.deleted && fields.kind === 'folder' ? { encryptedName: fields.encryptedName } : {}),
    } as Omit<VaultRecord, 'mac'>;
    const result = this.codec.sealRecord(record, scopeKey) as SyncRecord;
    this.assertShape(VaultRecordDtoSchema, result, 'record');
    return result;
  }

  verifyRecord(record: unknown, scopeKey: Uint8Array, expect: { vaultId: string; scope: string; id?: string }): void {
    this.assertShape(VaultRecordDtoSchema, record, 'record');
    this.codec.verifyRecord(record as VaultRecord, scopeKey, expect);
  }

  stateHash(records: Iterable<Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>>): string {
    return this.codec.stateHash([...records] as VaultRecord[]);
  }

  buildHead(
    { vaultId, scope, seq, records, prevHeadMac = '' }: { vaultId: string; scope: string; seq: number; records: Iterable<SyncRecord>; prevHeadMac?: string },
    scopeKey: Uint8Array,
  ): SyncHead {
    return this.codec.createHead(vaultId, scope, seq, prevHeadMac, [...records] as VaultRecord[], scopeKey) as SyncHead;
  }

  verifyHead(
    head: unknown,
    scopeKey: Uint8Array,
    expected: { vaultId: string; scope: string; records: Iterable<SyncRecord>; minSeq?: number; expectedPrevHeadMac?: string },
  ): void {
    this.assertShape(VaultHeadDtoSchema, head, 'head');
    this.codec.verifyHead(head as VaultHead, scopeKey, [...expected.records] as VaultRecord[], expected.minSeq ?? 0, expected.expectedPrevHeadMac);
  }

  encryptItem(plaintextJson: string, ownerKey: Uint8Array, ownerId: string, itemId: string): SyncItem {
    const records = new DefaultVaultRecordCodec(this.codec, this.crypto, this.random, ownerKey, ownerId);
    return records.encryptItem(JSON.parse(plaintextJson), itemId);
  }

  decryptItem(item: SyncItem, ownerKey: Uint8Array, ownerId: string, itemId: string): string {
    return this.codec.decryptItem(item, ownerKey, ownerId, itemId);
  }

  /** Fail closed on any shape the domain DTO schema refuses. The code is `<kind>_shape`. */
  private assertShape(schema: ShapeSchema, value: unknown, kind: 'bundle' | 'record' | 'head'): void {
    if (!schema.safeParse(value).success) throw new EnvelopeError(`${ kind }_shape`, `Vault ${ kind } is malformed`);
  }
}
