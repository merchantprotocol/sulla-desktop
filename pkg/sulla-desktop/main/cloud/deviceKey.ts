// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Desktop device key: the Ed25519 identity this install uses to prove to Sulla Cloud that a request really comes from
 * THIS machine. Thin async delegates to the shared domain `DeviceIdentityService` (`desktopDeviceIdentity()`), kept so
 * the signers don't change shape. The bytes signed are the domain `DeviceMessage` (purpose tag + parts, ts in unix
 * SECONDS last for `signDeviceMessage`), the same bytes the sulla-workers verifier checks.
 *
 * Stored in ~/.sulla/device-key.json (v1: base64 raw public key + PKCS#8 PEM, 0600, dir 0700). Only the public key is
 * sent to Cloud (/devices/register). A stolen access token can't impersonate the desktop without it.
 */

import { DeviceMessage, type DevicePurpose } from '@sulla/domain';

import { DesktopDeviceIdentity, desktopDeviceIdentity } from './device/DesktopDeviceIdentity';

export type { DevicePurpose };

/** Raw 32-byte public key, base64: the format the cloud stores. */
export async function getDevicePublicKey(): Promise<string> {
  return desktopDeviceIdentity().publicKey();
}

/** Short fingerprint shown in Settings so the owner can match it to the dashboard. */
export async function getDeviceKeyFingerprint(): Promise<string> {
  return (await desktopDeviceIdentity().signingKey()).fingerprint();
}

export function deviceMessage(purpose: DevicePurpose, parts: (string | number)[]): string {
  return new DeviceMessage(purpose, parts).toString();
}

/** Sign an already-complete purpose-bound field list (for contracts where ts is not the final field). */
export async function signDeviceMessageExact(purpose: DevicePurpose, parts: (string | number)[]): Promise<string> {
  return desktopDeviceIdentity().signExact(purpose, parts);
}

/** Sign a purpose-bound message. Returns { ts, signature } (unix seconds, base64). */
export async function signDeviceMessage(purpose: DevicePurpose, parts: (string | number)[]): Promise<{ ts: number; signature: string }> {
  const { ts, signature } = await desktopDeviceIdentity().sign(purpose, parts);

  return { ts, signature };
}

/** Test seam: the next call rebuilds the identity from paths. */
export function _resetDeviceKeyCache(): void {
  DesktopDeviceIdentity.useInstance(null);
}
