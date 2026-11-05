// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Passwords sync v3 for the vault container (VAULT-E2E-DESIGN.md §2–§3).
// Bundle sealing/verification, record verification, item decryption and
// key unwrapping run in @sulla/domain (VaultSyncCodec, KeyWrap). This class owns
// what stays Desktop's: strict shape checks first, so malformed input keeps its
// established error code, then translation of domain failures into EnvelopeError.
// Record/head sealing and head verification go through the TEMP VaultSyncSealer.
// Pinned to the shared vault-sync-v3 known-answer fixture, like the browser twin
// www-sulladesktop js/cloud/passwords/sync-envelope.js.

import type { KeyWrap, MasterKeyDeriver, VaultBundle, VaultRecord, VaultSyncCodec } from '@sulla/domain';

import {
  EnvelopeError,
  type BundleFields,
  type HeadExpectation,
  type HeadInput,
  type RecordExpectation,
  type RecordFields,
  type SyncBundle,
  type SyncHead,
  type SyncRecord,
} from './VaultSyncContracts.js';
import type { VaultSyncSealer } from './VaultSyncSealer.js';
import { VaultSyncShape } from './VaultSyncShape.js';

export class VaultSyncEnvelope {
  private static readonly USER_KEY_AAD = 'sulla:user-key:v1';

  constructor(
    private readonly codec: VaultSyncCodec,
    private readonly wraps: KeyWrap,
    private readonly masterKeys: MasterKeyDeriver,
    private readonly sealer: VaultSyncSealer,
    private readonly shape: VaultSyncShape,
  ) {}

  buildBundle(fields: BundleFields, userKey: Uint8Array): SyncBundle {
    this.shape.assertKey(userKey);
    const body = { format: VaultSyncShape.FORMAT.bundle, v: fields.recovery ? (2 as const) : (1 as const), ...fields };
    let bundle: unknown;
    try {
      bundle = this.codec.sealBundle(body as Omit<VaultBundle, 'mac'>, userKey);
    } catch (error) {
      throw EnvelopeError.fromDomain(error);
    }
    this.shape.checkBundle(bundle);
    return bundle;
  }

  verifyBundle(bundle: unknown, userKey: Uint8Array): void {
    this.shape.checkBundle(bundle);
    this.shape.assertKey(userKey);
    try {
      this.codec.verifyBundle(bundle as VaultBundle, userKey);
    } catch (error) {
      throw EnvelopeError.fromDomain(error, 'bundle_mac');
    }
  }

  /**
   * Unlock a bundle with the master password. Throws `wrong_password` when the
   * AEAD rejects the wrap (decided locally, nothing is sent anywhere).
   * Returns the user key; the caller owns it and must zero it.
   */
  unlockBundle(bundle: unknown, password: string): Uint8Array {
    this.shape.checkBundle(bundle);
    const masterKey = this.masterKeys.deriveMasterKey(password, bundle.kdf);
    let userKey: Uint8Array;
    try {
      userKey = this.wraps.open(masterKey, bundle.encryptedUserKey, VaultSyncEnvelope.USER_KEY_AAD);
    } catch {
      throw new EnvelopeError('wrong_password', 'Wrong master password');
    } finally {
      masterKey.fill(0);
    }
    try {
      this.verifyBundle(bundle, userKey);
    } catch (error) {
      userKey.fill(0);
      throw error;
    }
    return userKey;
  }

  buildRecord(fields: RecordFields, scopeKey: Uint8Array): SyncRecord {
    return this.sealer.sealRecord(fields, scopeKey);
  }

  /** Verify one record against the expected vault/scope. Throws on any mismatch. */
  verifyRecord(record: unknown, scopeKey: Uint8Array, expect: RecordExpectation): void {
    this.shape.checkRecord(record);
    if (record.vaultId !== expect.vaultId || record.scope !== expect.scope) {
      throw new EnvelopeError('record_moved', 'Record belongs to another vault or scope');
    }
    if (expect.id !== undefined && record.id !== expect.id) throw new EnvelopeError('record_moved', 'Record id does not match');
    this.shape.assertKey(scopeKey);
    try {
      this.codec.verifyRecord(record as VaultRecord, scopeKey, expect);
    } catch (error) {
      throw EnvelopeError.fromDomain(error, 'record_mac');
    }
  }

  buildHead(input: HeadInput, scopeKey: Uint8Array): SyncHead {
    return this.sealer.sealHead(input, scopeKey);
  }

  verifyHead(head: unknown, scopeKey: Uint8Array, expect: HeadExpectation): void {
    this.sealer.verifyHead(head, scopeKey, expect);
  }

  decryptItem(item: unknown, ownerKey: Uint8Array, ownerId: string, itemId: string): string {
    if (!this.shape.isEncryptedItem(item)) throw new EnvelopeError('envelope_shape', 'Item envelope is malformed');
    this.shape.assertKey(ownerKey);
    try {
      return this.codec.decryptItem(item, ownerKey, ownerId, itemId);
    } catch (error) {
      throw EnvelopeError.fromDomain(error);
    }
  }
}
