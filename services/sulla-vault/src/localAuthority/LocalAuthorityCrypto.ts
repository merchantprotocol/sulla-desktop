// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { BrokerExecuteRequest } from '../contracts.js';
import { LEGACY_PREFIX } from './LocalAuthorityLimits.js';
import type { LegacyIntegrationRow } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * The local authority's small crypto helpers: constant-time compare, proof HMACs, the sealed
 * cache-update envelope, canonical operation digests and legacy `$VAULT$` values.
 * Moved verbatim from localAuthority.ts (E9). Static methods never use `this`.
 */
export class LocalAuthorityCrypto {
  static sealCacheUpdate(clear: Buffer, key: Buffer, nonce: Buffer): string {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    const sealed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    ciphertext.fill(0);
    try {
      return sealed.toString('base64url');
    } finally {
      sealed.fill(0);
    }
  }

  static constantEqual(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  static hmac(token: string, value: string): string {
    return createHmac('sha256', token).update(value).digest('base64url');
  }

  static canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${ value.map(LocalAuthorityCrypto.canonical).join(',') }]`;
    return `{${ Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${ JSON.stringify(key) }:${ LocalAuthorityCrypto.canonical(child) }`).join(',') }}`;
  }

  static operationDigest(input: BrokerExecuteRequest): string {
    return createHash('sha256').update(LocalAuthorityCrypto.canonical({
      claims: input.claims,
      operation: input.operation,
      ref: input.ref,
      url: input.url,
      method: input.method,
      headers: input.headers ?? {},
      body: input.body ?? null,
      bodyEncoding: input.bodyEncoding ?? null,
      injections: input.injections,
      responseType: input.responseType ?? 'json',
    })).digest('base64url');
  }

  static decryptLegacyValue(value: string, key: Buffer | undefined): string {
    if (!value.startsWith(LEGACY_PREFIX)) return value;
    if (!key) throw new LocalVaultError('migration_failed', 409, 'Legacy encrypted rows require the migration key');
    const packed = Buffer.from(value.slice(LEGACY_PREFIX.length), 'base64');
    if (packed.byteLength < 28) throw new LocalVaultError('migration_failed', 409, 'Legacy ciphertext is truncated');
    const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
  }

  static stableLegacyFingerprint(rows: LegacyIntegrationRow[]): string {
    const hash = createHash('sha256');
    for (const row of rows) {
      hash.update(JSON.stringify([
        row.value_id, row.integration_id, row.account_id, row.property, row.value,
        row.is_default, row.created_at, row.updated_at, row.source_kind,
      ]));
      hash.update('\n');
    }
    return hash.digest('base64url');
  }
}
