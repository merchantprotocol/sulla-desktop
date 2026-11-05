// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// TEMP until @sulla/domain v0.2.1 sealRecord/sealHead/code-unit stateHash; delete then.
//
// @sulla/domain v0.2.0 VaultSyncCodec has no sealRecord or sealHead, and its
// stateHash sorts record ids with localeCompare. Desktop's wire format (and the
// browser twin www-sulladesktop js/cloud/passwords/sync-envelope.js) sorts by
// UTF-16 code unit, so the domain hash differs on mixed-case or non-ASCII ids
// and so does its verifyHead. Everything here runs on domain primitives (MAC
// subkey via VaultSyncCodec.deriveMacKey, BLAKE2b, SHA-256, CanonicalJson); only
// the record/head assembly and the code-unit ordering are Desktop's.

import { Bytes, type CanonicalJson, type CryptoPrimitives, type VaultSyncCodec } from '@sulla/domain';

import {
  EnvelopeError,
  type HeadExpectation,
  type HeadInput,
  type RecordFields,
  type StateRecord,
  type SyncHead,
  type SyncRecord,
} from './VaultSyncContracts.js';
import { VaultSyncShape } from './VaultSyncShape.js';

export class VaultSyncSealer {
  private static readonly MAC_BYTES = 32;

  constructor(
    private readonly crypto: CryptoPrimitives,
    private readonly codec: VaultSyncCodec,
    private readonly canonical: CanonicalJson,
    private readonly shape: VaultSyncShape,
  ) {}

  sealRecord(fields: RecordFields, scopeKey: Uint8Array): SyncRecord {
    const body: Omit<SyncRecord, 'mac'> = {
      format: VaultSyncShape.FORMAT.record,
      v: VaultSyncShape.SUPPORTED_VERSION,
      vaultId: fields.vaultId,
      scope: fields.scope,
      kind: fields.kind,
      id: fields.id,
      generation: fields.generation,
      deleted: Boolean(fields.deleted),
    };
    if (!body.deleted && body.kind === 'item') {
      body.item = { version: 1, encryptedItemKey: fields.item!.encryptedItemKey, ciphertext: fields.item!.ciphertext };
    }
    if (!body.deleted && body.kind === 'folder') body.encryptedName = fields.encryptedName;
    this.shape.assertKey(scopeKey);
    const record: unknown = { ...body, mac: this.mac(scopeKey, this.recordMacFields(body)) };
    this.shape.checkRecord(record);
    return record;
  }

  sealHead({ vaultId, scope, seq, records, prevHeadMac = '' }: HeadInput, scopeKey: Uint8Array): SyncHead {
    const body: Omit<SyncHead, 'mac'> = {
      format: VaultSyncShape.FORMAT.head,
      v: VaultSyncShape.SUPPORTED_VERSION,
      vaultId,
      scope,
      seq,
      stateHash: this.stateHash(records),
      prevHeadMac,
    };
    const head: unknown = { ...body, mac: this.mac(scopeKey, this.headMacFields(body)) };
    this.shape.checkHead(head);
    return head;
  }

  /**
   * Verify a head against the full record set the client holds for that scope.
   * `minSeq` is the highest seq this client verified before: a lower seq is a
   * rollback. A stateHash mismatch means a record was omitted, added, or
   * replayed at an older generation.
   */
  verifyHead(head: unknown, scopeKey: Uint8Array, { vaultId, scope, records, minSeq = 0, expectedPrevHeadMac }: HeadExpectation): void {
    this.shape.checkHead(head);
    if (head.vaultId !== vaultId || head.scope !== scope)
      throw new EnvelopeError('head_moved', 'Manifest head belongs to another vault or scope');
    if (!this.macMatches(this.mac(scopeKey, this.headMacFields(head)), head.mac)) {
      throw new EnvelopeError('head_mac', 'Manifest head failed its integrity check');
    }
    if (head.seq < minSeq) throw new EnvelopeError('rollback', 'Sulla Cloud served an older copy than this browser has seen');
    if (expectedPrevHeadMac !== undefined && head.seq > minSeq && head.prevHeadMac !== expectedPrevHeadMac) {
      throw new EnvelopeError('head_chain', 'Manifest head does not extend the previously verified head');
    }
    if (this.stateHash(records) !== head.stateHash) throw new EnvelopeError('state_mismatch', 'Records do not match the signed manifest');
  }

  /** SHA-256 over the JCS of [id, generation, deleted, mac] rows, ordered by UTF-16 code unit. */
  stateHash(records: Iterable<StateRecord>): string {
    const rows = [...records]
      .map((r) => [r.id, r.generation, r.deleted, r.mac] as [string, number, boolean, string])
      .sort((a, b) => this.compareCodeUnits(a[0], b[0]));
    for (let i = 1; i < rows.length; i++)
      if (rows[i][0] === rows[i - 1][0]) throw new EnvelopeError('duplicate_record', 'Two records share one id');
    return this.sha256(rows);
  }

  private compareCodeUnits(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private contentHash(record: Pick<SyncRecord, 'deleted' | 'kind' | 'item' | 'encryptedName'>): string {
    if (record.deleted) return '';
    return this.sha256(record.kind === 'item' ? record.item : record.encryptedName);
  }

  private recordMacFields(record: Omit<SyncRecord, 'mac'>): object {
    return {
      format: VaultSyncShape.FORMAT.record,
      v: VaultSyncShape.SUPPORTED_VERSION,
      vaultId: record.vaultId,
      scope: record.scope,
      kind: record.kind,
      id: record.id,
      generation: record.generation,
      deleted: record.deleted,
      contentHash: this.contentHash(record),
    };
  }

  private headMacFields(head: Omit<SyncHead, 'mac'>): object {
    return {
      format: VaultSyncShape.FORMAT.head,
      v: VaultSyncShape.SUPPORTED_VERSION,
      vaultId: head.vaultId,
      scope: head.scope,
      seq: head.seq,
      stateHash: head.stateHash,
      prevHeadMac: head.prevHeadMac,
    };
  }

  /** Keyed BLAKE2b-256 under the scope's MAC subkey (crypto_kdf id 1, context "SVsync01"), never the scope key itself. */
  private mac(scopeKey: Uint8Array, fields: object): string {
    this.shape.assertKey(scopeKey);
    const macKey = this.codec.deriveMacKey(scopeKey);
    try {
      return Bytes.toBase64Url(this.crypto.blake2b(this.canonicalBytes(fields), VaultSyncSealer.MAC_BYTES, macKey));
    } finally {
      macKey.fill(0);
    }
  }

  /** Constant-time comparison; a value that does not decode as canonical base64url never matches. */
  private macMatches(expected: string, actual: string): boolean {
    if (expected.length !== actual.length) return false;
    try {
      return Bytes.equal(Bytes.fromBase64Url(expected), Bytes.fromBase64Url(actual));
    } catch {
      return false;
    }
  }

  private sha256(value: unknown): string {
    return Bytes.toBase64Url(this.crypto.sha256(this.canonicalBytes(value)));
  }

  private canonicalBytes(value: unknown): Uint8Array {
    try {
      return Bytes.utf8(this.canonical.stringify(value));
    } catch (error) {
      throw EnvelopeError.fromDomain(error);
    }
  }
}
