import fs from 'node:fs/promises';
import path from 'node:path';
import Electron from 'electron';

import paths from '@pkg/utils/paths';
import { verifyVaultCertificate } from './vaultTlsVerifier';

export { vaultCertificateMetadataMatches, verifyVaultCertificate } from './vaultTlsVerifier';

export const VAULT_HTTPS_ORIGIN = 'https://127.0.0.1:30135';

let pinnedFingerprint: Promise<string> | undefined;

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').trim().toLowerCase();
}
async function readPinnedFingerprint(): Promise<string> {
  const value = normalizeFingerprint(await fs.readFile(path.join(paths.appHome, 'vault-tls-fingerprint'), 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Vault TLS fingerprint is missing or invalid');
  return value;
}

async function getPinnedFingerprint(): Promise<string> {
  pinnedFingerprint ??= readPinnedFingerprint();
  try {
    return await pinnedFingerprint;
  } catch (error) {
    pinnedFingerprint = undefined;
    throw error;
  }
}

export async function configureVaultPinnedSession(session: Electron.Session): Promise<void> {
  const expected = await getPinnedFingerprint();
  session.setCertificateVerifyProc((request, callback) => {
    callback(verifyVaultCertificate(request.hostname, request.certificate.data, expected) ? 0 : -2);
  });
}

