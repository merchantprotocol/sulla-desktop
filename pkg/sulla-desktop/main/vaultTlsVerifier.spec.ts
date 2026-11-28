// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { vaultCertificateMetadataMatches } from './vaultTlsVerifier';

describe('vault TLS peer pin checks', () => {
  const certificate = {
    fingerprint256: 'AA:'.repeat(31) + 'AA',
    validFrom: 'Jan  1 00:00:00 2026 GMT',
    validTo: 'Jan  1 00:00:00 2028 GMT',
    checkIP: (hostname: string) => hostname === '127.0.0.1' ? hostname : undefined,
  };

  it('accepts a valid loopback certificate only when its SHA-256 pin matches', () => {
    // risk: authentication — an untrusted local process must not impersonate the vault.
    expect(vaultCertificateMetadataMatches('127.0.0.1', certificate, 'aa'.repeat(32), Date.parse('2026-11-18T00:00:00Z'))).toBe(true);
    expect(vaultCertificateMetadataMatches('127.0.0.1', certificate, 'bb'.repeat(32), Date.parse('2026-11-18T00:00:00Z'))).toBe(false);
  });

  it('rejects a matching pin outside the loopback host or certificate validity window', () => {
    // risk: authentication — certificate hostname and validity are part of the pin decision.
    expect(vaultCertificateMetadataMatches('localhost', certificate, 'aa'.repeat(32), Date.parse('2026-11-18T00:00:00Z'))).toBe(false);
    expect(vaultCertificateMetadataMatches('127.0.0.1', certificate, 'aa'.repeat(32), Date.parse('2029-01-01T00:00:00Z'))).toBe(false);
  });
});
