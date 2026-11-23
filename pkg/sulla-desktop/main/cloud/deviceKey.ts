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

import { DeviceMessage, type DevicePurpose as DomainDevicePurpose } from '@sulla/domain';

import { DesktopDeviceIdentity, desktopDeviceIdentity } from './device/DesktopDeviceIdentity';

/**
 * Desktop-only purpose tags that are not yet in the vendored domain registry (Slack SLACK-1, Org Files key
 * recipients). They use the same framing (tag + parts joined by "\n", no newline inside a part) and are signed with
 * the same device key through `signBytes`. Every other purpose goes through the domain codec unchanged.
 */
export class LocalDeviceMessage {
  static readonly PURPOSE_TAGS = {
    'slack-inbound-v1':   'sulla-slack-inbound-v1',
    'slack-workspace-v1': 'sulla-slack-workspace-v1',
    'shared-live-relay-v1': 'sulla-shared-live-relay-v1',
    'org-files-key-v1':   'sulla-org-files-key-v1',
  } as const;

  static isLocalPurpose(purpose: string): purpose is LocalDevicePurpose {
    return Object.hasOwn(LocalDeviceMessage.PURPOSE_TAGS, purpose);
  }

  static bytes(purpose: LocalDevicePurpose, parts: ReadonlyArray<string | number>): Buffer {
    const values = parts.map(String);
    if (values.some(value => value.includes('\n'))) throw new TypeError('message parts must not contain newlines');
    return Buffer.from([LocalDeviceMessage.PURPOSE_TAGS[purpose], ...values].join('\n'), 'utf8');
  }
}

export type LocalDevicePurpose = keyof typeof LocalDeviceMessage.PURPOSE_TAGS;
export type DevicePurpose = DomainDevicePurpose | LocalDevicePurpose;

/** Raw 32-byte public key, base64: the format the cloud stores. */
export async function getDevicePublicKey(): Promise<string> {
  return desktopDeviceIdentity().publicKey();
}

/** Short fingerprint shown in Settings so the owner can match it to the dashboard. */
export async function getDeviceKeyFingerprint(): Promise<string> {
  return (await desktopDeviceIdentity().signingKey()).fingerprint();
}

export function deviceMessage(purpose: DevicePurpose, parts: (string | number)[]): string {
  if (LocalDeviceMessage.isLocalPurpose(purpose)) return LocalDeviceMessage.bytes(purpose, parts).toString('utf8');
  return new DeviceMessage(purpose, parts).toString();
}

/** Sign an already-complete purpose-bound field list (for contracts where ts is not the final field). */
export async function signDeviceMessageExact(purpose: DevicePurpose, parts: (string | number)[]): Promise<string> {
  if (LocalDeviceMessage.isLocalPurpose(purpose)) return desktopDeviceIdentity().signBytes(LocalDeviceMessage.bytes(purpose, parts));
  return desktopDeviceIdentity().signExact(purpose, parts);
}

/** Sign a purpose-bound message. Returns { ts, signature } (unix seconds, base64). */
export async function signDeviceMessage(purpose: DevicePurpose, parts: (string | number)[]): Promise<{ ts: number; signature: string }> {
  if (LocalDeviceMessage.isLocalPurpose(purpose)) {
    const slackTs = Math.floor(Date.now() / 1000);
    const bytes = LocalDeviceMessage.bytes(purpose, [...parts, slackTs]);

    return { ts: slackTs, signature: await desktopDeviceIdentity().signBytes(bytes) };
  }
  const { ts, signature } = await desktopDeviceIdentity().sign(purpose, parts);

  return { ts, signature };
}

/** Test seam: the next call rebuilds the identity from paths. */
export function _resetDeviceKeyCache(): void {
  DesktopDeviceIdentity.useInstance(null);
}
