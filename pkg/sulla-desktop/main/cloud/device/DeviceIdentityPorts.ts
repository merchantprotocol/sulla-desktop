// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Desktop-local ports for device identity (D-ID-2).
 *
 * They mirror the planned shared-domain shape (C-ID-3: DeviceId, DeviceIdStore,
 * DeviceKeyStore, DeviceIdentityService) so moving to `@sulla/domain` is an import
 * change once it ships. Two deliberate Desktop differences, to tell M1 about:
 *   - the stores are synchronous, because ~10 Desktop signers call `signDeviceMessage`
 *     synchronously today (relay, vault, files, support, tools);
 *   - the key store hands out the raw 32-byte Ed25519 seed; on disk it stays the
 *     v1 PKCS#8 PEM file so existing installs keep their key.
 */

/** Where the stable device id lives. `read` returns the raw stored text, or null when there is none. */
export interface DeviceIdStore {
  read(): string | null;
  /** Throws when the id could not be saved. */
  write(id: string): void;
}

/** An Ed25519 device key: base64 raw 32-byte public key + the 32-byte private seed. */
export interface StoredDeviceKey {
  publicKey: string;
  seed:      Uint8Array;
  createdAt: string;
}

export interface DeviceKeyStore {
  /** Null only when no key file exists. A present-but-unreadable key throws (fails closed). */
  read(): StoredDeviceKey | null;
  /** Throws when the key could not be saved. */
  write(key: StoredDeviceKey): void;
}

/** Older installs kept the id in app settings; read it once and keep writing it there as a backup. */
export interface LegacyDeviceIdSource {
  read(): Promise<string | null>;
  write(id: string): Promise<void>;
}

/** Cryptographically secure randomness only. Implementations throw rather than fall back. */
export interface RandomSource {
  bytes(length: number): Uint8Array;
}

/** Same method names as the domain `CryptoPrimitives` (seed-based Ed25519). */
export interface Ed25519Primitives {
  ed25519PublicKey(seed: Uint8Array): Uint8Array;
  ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array;
}

export interface DeviceClock {
  nowSeconds(): number;
  nowIso(): string;
}

/**
 * How the key in use came to be:
 * - `existing`: read from disk;
 * - `created`: first key for an id minted in this process (a new install);
 * - `regenerated_after_loss`: the id was already on disk but the key file was gone, so this
 *   machine has a new key that Cloud has never seen. Cloud will refuse it (409
 *   `device_key_mismatch`) until the owner re-links the computer.
 */
export type KeyOrigin = 'existing' | 'created' | 'regenerated_after_loss';

export interface LoadedDeviceIdentity {
  deviceId:  string;
  publicKey: string;
  keyOrigin: KeyOrigin;
}

/** `{ts, signature}` for `/devices/register`, as Cloud's DeviceKeyVerifier expects. */
export interface KeyRotateProof {
  ts:        number;
  signature: string;
}

/** Whether the device id survives a restart. A non-persisted id must never be registered. */
export interface DeviceIdentityHealth {
  idPersisted: boolean;
  error?:      'device_id_not_saved';
}

export type DeviceIdentityErrorCode = 'csprng_unavailable' | 'device_id_malformed' | 'device_key_unreadable' | 'device_key_not_saved';

export class DeviceIdentityError extends Error {
  constructor(readonly code: DeviceIdentityErrorCode, message: string) {
    super(message);
    this.name = 'DeviceIdentityError';
  }
}
