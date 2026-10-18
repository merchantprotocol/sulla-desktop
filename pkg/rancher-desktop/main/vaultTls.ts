import fs from 'node:fs/promises';
import path from 'node:path';

import Electron from 'electron';

import { verifyVaultCertificate } from './vaultTlsVerifier';

import paths from '@pkg/utils/paths';

export { vaultCertificateMetadataMatches, verifyVaultCertificate } from './vaultTlsVerifier';

export const VAULT_HTTPS_ORIGIN = 'https://127.0.0.1:30135';

let pinnedFingerprint: Promise<string> | undefined;
const pinnedSessions = new Set<WeakRef<Electron.Session>>();
const registeredSessions = new WeakSet<Electron.Session>();

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').trim().toLowerCase();
}
async function readPinnedFingerprint(): Promise<string> {
  const value = normalizeFingerprint(await fs.readFile(path.join(paths.appHome, 'vault-tls-fingerprint'), 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Vault TLS fingerprint is missing or invalid');
  return value;
}

async function getPinnedFingerprint(): Promise<string> {
  for (;;) {
    const pending = pinnedFingerprint ??= readPinnedFingerprint();
    try {
      const value = await pending;
      // Provisioning can replace the pin while an initial disk read is pending.
      if (pending === pinnedFingerprint) return value;
    } catch (error) {
      if (pending === pinnedFingerprint) pinnedFingerprint = undefined;
      throw error;
    }
  }
}

/** Replace verifier callbacks after provisioning republishes the public pin. */
export async function refreshVaultPinnedSessions(): Promise<void> {
  pinnedFingerprint = readPinnedFingerprint();
  const updates: Promise<void>[] = [];
  for (const reference of pinnedSessions) {
    const session = reference.deref();
    if (session) updates.push(configureVaultPinnedSession(session));
    else pinnedSessions.delete(reference);
  }
  await Promise.all([getPinnedFingerprint(), ...updates]);
}

export async function configureVaultPinnedSession(session: Electron.Session): Promise<void> {
  if (!registeredSessions.has(session)) {
    registeredSessions.add(session);
    pinnedSessions.add(new WeakRef(session));
  }
  // Fail closed during a refresh and if the replacement pin cannot be read.
  session.setCertificateVerifyProc((_request, callback) => callback(-2));
  const expected = await getPinnedFingerprint();
  session.setCertificateVerifyProc((request, callback) => {
    callback(verifyVaultCertificate(request.hostname, request.certificate.data, expected) ? 0 : -2);
  });
}
