// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Desktop device key — the Ed25519 identity this install uses to prove to
 * Sulla Cloud that a request really comes from THIS machine.
 *
 * Generated locally on first use and stored next to the device id in
 * ~/.sulla (0600). Only the public key is ever sent to the cloud (enrolled
 * via /devices/register). The cloud then requires a signature from it
 * before it will:
 *   - admit this machine to the secure desktop channel as role=desktop, and
 *   - accept an upload of this machine's vault/projects copy.
 *
 * So a stolen Sulla Cloud access token can't impersonate the desktop.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import paths from '@pkg/utils/paths';
import { DeviceMessage, type DevicePurpose as DomainDevicePurpose } from '@sulla/domain';

interface StoredKey {
  v:          1;
  publicKey:  string; // base64 raw 32-byte Ed25519 key
  privateKey: string; // PKCS#8 PEM
  createdAt:  string;
}

let cached: { publicKey: string; key: crypto.KeyObject } | null = null;

function keyPath(): string {
  return path.join(paths.sullaConfig, 'device-key.json');
}

/** Raw 32-byte public key, base64 — the format the cloud stores. */
export function rawPublicKeyB64(pub: crypto.KeyObject): string {
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('not an Ed25519 public key');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

function load(): { publicKey: string; key: crypto.KeyObject } {
  if (cached) return cached;
  const file = keyPath();
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredKey;
    if (stored.v === 1 && stored.privateKey && stored.publicKey) {
      const key = crypto.createPrivateKey(stored.privateKey);
      // Recompute rather than trust the stored copy.
      const publicKey = rawPublicKeyB64(crypto.createPublicKey(key));
      cached = { publicKey, key };
      return cached;
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw new Error(`[deviceKey] unreadable ${ file }: ${ err?.message || err }`);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const stored: StoredKey = {
    v:          1,
    publicKey:  rawPublicKeyB64(publicKey),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    createdAt:  new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash can't leave a half-written key behind.
  const tmp = `${ file }.${ process.pid }.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cached = { publicKey: stored.publicKey, key: privateKey };
  return cached;
}

export function getDevicePublicKey(): string {
  return load().publicKey;
}

/** Short fingerprint shown in Settings so the owner can match it to the dashboard. */
export function getDeviceKeyFingerprint(): string {
  const hex = crypto.createHash('sha256').update(getDevicePublicKey()).digest('hex').slice(0, 16);
  return hex.replace(/(.{4})(?!$)/g, '$1-');
}

// Slack purpose tags are introduced by this feature and are not yet in the vendored
// domain package. All existing purposes continue through the shared domain codec.
const SLACK_PURPOSE_TAGS = {
  'slack-inbound-v1': 'sulla-slack-inbound-v1',
  'slack-workspace-v1': 'sulla-slack-workspace-v1',
} as const;
export type DevicePurpose = DomainDevicePurpose | keyof typeof SLACK_PURPOSE_TAGS;

function deviceMessageBytes(purpose: DevicePurpose, parts: (string | number)[]): Buffer {
  if (Object.hasOwn(SLACK_PURPOSE_TAGS, purpose)) {
    const values = parts.map(String);
    if (values.some(value => value.includes('\n'))) throw new TypeError('message parts must not contain newlines');
    return Buffer.from([SLACK_PURPOSE_TAGS[purpose as keyof typeof SLACK_PURPOSE_TAGS], ...values].join('\n'), 'utf8');
  }
  return Buffer.from(new DeviceMessage(purpose as DomainDevicePurpose, parts).toBytes());
}

export function deviceMessage(purpose: DevicePurpose, parts: (string | number)[]): string {
  return deviceMessageBytes(purpose, parts).toString('utf8');
}

/** Sign an already-complete purpose-bound field list (for contracts where ts is not the final field). */
export function signDeviceMessageExact(purpose: DevicePurpose, parts: (string | number)[]): string {
  return crypto.sign(null, deviceMessageBytes(purpose, parts), load().key).toString('base64');
}

/** Sign a purpose-bound message. Returns { ts, signature } (unix seconds, base64). */
export function signDeviceMessage(purpose: DevicePurpose, parts: (string | number)[]): { ts: number; signature: string } {
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.sign(null, deviceMessageBytes(purpose, [...parts, ts]), load().key).toString('base64');
  return { ts, signature };
}

/** Test seam. */
export function _resetDeviceKeyCache(): void {
  cached = null;
}
