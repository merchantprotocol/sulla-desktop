import { vaultCertificateMetadataMatches } from '../vaultTlsVerifier';

describe('vault TLS pin verification', () => {
  const now = Date.parse('2026-10-17T20:00:00Z');
  const fingerprint = 'ab'.repeat(32);
  const certificate = {
    fingerprint256: fingerprint.match(/../g)!.join(':'),
    validFrom:       '2026-10-16T20:00:00Z',
    validTo:         '2027-10-17T20:00:00Z',
    checkIP:         (hostname: string) => hostname === '127.0.0.1' ? hostname : undefined,
  };

  test('accepts only the pinned, current loopback certificate', () => {
    expect(vaultCertificateMetadataMatches('127.0.0.1', certificate, fingerprint, now)).toBe(true);
    expect(vaultCertificateMetadataMatches('localhost', certificate, fingerprint, now)).toBe(false);
    expect(vaultCertificateMetadataMatches('127.0.0.1', certificate, 'cd'.repeat(32), now)).toBe(false);
    expect(vaultCertificateMetadataMatches('127.0.0.1', certificate, fingerprint, Date.parse('2028-01-01T00:00:00Z'))).toBe(false);
  });
});
