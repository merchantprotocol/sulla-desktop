// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { resolveTrustedPublisherKeysPath, trustedPublisherVerifier } from '@pkg/agent/integrations/packageLoader';

export interface MarketplaceSignatureManifest {
  integrity?: string;
  signature?: { algorithm: 'ed25519'; keyId: string; value: string };
  [key: string]: unknown;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${ value.map(stableJson).join(',') }]`;
  if (value && typeof value === 'object') {
    return `{${ Object.keys(value as object).sort().map(key => `${ JSON.stringify(key) }:${ stableJson((value as Record<string, unknown>)[key]) }`).join(',') }}`;
  }
  return JSON.stringify(value);
}

/** Canonical marketplace hash: same manifest+file-digest algorithm as integrationPackageHash. */
export function marketplaceArtifactHash(manifestValue: MarketplaceSignatureManifest, payload: Buffer): string {
  const { integrity: _integrity, signature: _signature, ...manifest } = manifestValue;
  const files = { 'bundle.zip': createHash('sha256').update(payload).digest('hex') };
  return `sha256:${ createHash('sha256').update(stableJson({ manifest, files })).digest('hex') }`;
}

/** True once the trusted-keys file sets requireSignatures. Until then unsigned listings install with a warning. */
export function marketplaceSignaturesRequired(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveTrustedPublisherKeysPath(), 'utf8'));
    return parsed?.requireSignatures === true;
  } catch { return false }
}

export function isSignedMarketplaceManifest(manifest: MarketplaceSignatureManifest | undefined): boolean {
  return !!manifest?.integrity && !!manifest?.signature;
}

export function verifyMarketplaceArtifact(manifest: MarketplaceSignatureManifest, payload: Buffer): void {
  const { integrity, signature } = manifest;
  if (!integrity || !signature) {
    if (marketplaceSignaturesRequired()) throw new Error('Marketplace download is unsigned; installation was refused.');
    console.warn('[marketplace] Installing an unsigned listing; signatures are not required yet.');
    return;
  }
  const actual = marketplaceArtifactHash(manifest, payload);
  if (actual !== integrity) throw new Error('Marketplace download integrity check failed; the package may have been tampered with.');
  const verifier = trustedPublisherVerifier(resolveTrustedPublisherKeysPath());
  if (!verifier.verify({ integrity: actual, signature })) {
    throw new Error('Marketplace publisher signature is not trusted; installation was refused.');
  }
}

/** Self-contained packages are signed over their unsigned JSON bytes. */
export function verifySelfContainedMarketplaceArtifact(manifest: MarketplaceSignatureManifest): void {
  const { integrity: _integrity, signature: _signature, ...unsigned } = manifest;
  verifyMarketplaceArtifact(manifest, Buffer.from(JSON.stringify(unsigned), 'utf8'));
}
