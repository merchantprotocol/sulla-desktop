import { X509Certificate } from 'node:crypto';

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').trim().toLowerCase();
}
export interface VaultCertificateMetadata {
  fingerprint256: string;
  validFrom: string;
  validTo: string;
  checkIP(hostname: string): string | undefined;
}

export function vaultCertificateMetadataMatches(
  hostname: string, certificate: VaultCertificateMetadata, expectedFingerprint: string, now = Date.now(),
): boolean {
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  return hostname === '127.0.0.1' && certificate.checkIP(hostname) === hostname &&
    Number.isFinite(validFrom) && Number.isFinite(validTo) && now >= validFrom && now <= validTo &&
    normalizeFingerprint(certificate.fingerprint256) === normalizeFingerprint(expectedFingerprint);
}

export function verifyVaultCertificate(hostname: string, pem: string, expectedFingerprint: string, now = Date.now()): boolean {
  try {
    return vaultCertificateMetadataMatches(hostname, new X509Certificate(pem), expectedFingerprint, now);
  } catch {
    return false;
  }
}

