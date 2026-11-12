// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Desktop device key — the Ed25519 identity this install uses to prove to Sulla Cloud that a
 * request really comes from THIS machine. Thin delegates to `DesktopDeviceIdentity`
 * (main/cloud/device), kept so the ~10 signers don't change.
 *
 * Stored in ~/.sulla/device-key.json (v1: base64 raw public key + PKCS#8 PEM, 0600, dir 0700).
 * Only the public key is sent to Cloud (/devices/register). A stolen access token can't
 * impersonate the desktop without it.
 */

import crypto from 'crypto';

import { DeviceMessage, type DevicePurpose } from '@sulla/domain';

import { thisDevice } from './device/thisDevice';

/** Raw 32-byte public key, base64 — the format the cloud stores. */
export function rawPublicKeyB64(pub: crypto.KeyObject): string {
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('not an Ed25519 public key');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

export function getDevicePublicKey(): string {
  return thisDevice.publicKey();
}

/** Short fingerprint shown in Settings so the owner can match it to the dashboard. */
export function getDeviceKeyFingerprint(): string {
  return thisDevice.keyFingerprint();
}

// The purpose registry (tag per purpose) is the shared domain DeviceMessage; it matches the sulla-workers
// verifier. An unknown purpose or a newline in a part throws instead of signing the wrong bytes.
export type { DevicePurpose };

export function deviceMessage(purpose: DevicePurpose, parts: (string | number)[]): string {
  return new DeviceMessage(purpose, parts).toString();
}

/** Sign an already-complete purpose-bound field list (for contracts where ts is not the final field). */
export function signDeviceMessageExact(purpose: DevicePurpose, parts: (string | number)[]): string {
  return thisDevice.signExact(purpose, parts);
}

/** Sign a purpose-bound message. Returns { ts, signature } (unix seconds, base64). */
export function signDeviceMessage(purpose: DevicePurpose, parts: (string | number)[]): { ts: number; signature: string } {
  return thisDevice.sign(purpose, parts);
}

/** Test seam. */
export function _resetDeviceKeyCache(): void {
  thisDevice.resetCache();
}
