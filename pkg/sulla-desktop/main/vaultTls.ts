// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import path from 'node:path';

import Electron from 'electron';

import { verifyVaultCertificate } from './vaultTlsVerifier';

import paths from '@pkg/utils/paths';
import { loopbackOrigin } from '@pkg/utils/instance';

export { vaultCertificateMetadataMatches, verifyVaultCertificate } from './vaultTlsVerifier';

export const VAULT_HTTPS_ORIGIN = loopbackOrigin('https', 30135);

const FINGERPRINT_FILE = 'vault-tls-fingerprint';

/**
 * Pins the locally provisioned vault certificate onto Electron sessions. Holds the current pin and
 * every session it has configured, so a provisioning refresh can re-pin them all.
 */
export class VaultTlsPinService {
  private pinnedFingerprint: Promise<string> | undefined;
  private readonly pinnedSessions = new Set<WeakRef<Electron.Session>>();
  private readonly registeredSessions = new WeakSet<Electron.Session>();

  constructor(private readonly readFingerprintFile: () => Promise<string> = () => fs.readFile(path.join(paths.appHome, FINGERPRINT_FILE), 'utf8')) {}

  /** Replace verifier callbacks after provisioning republishes the public pin. */
  async refresh(): Promise<void> {
    this.pinnedFingerprint = this.readPinnedFingerprint();
    const updates: Promise<void>[] = [];
    for (const reference of this.pinnedSessions) {
      const session = reference.deref();
      if (session) updates.push(this.configureSession(session));
      else this.pinnedSessions.delete(reference);
    }
    await Promise.all([this.getPinnedFingerprint(), ...updates]);
  }

  async configureSession(session: Electron.Session): Promise<void> {
    if (!this.registeredSessions.has(session)) {
      this.registeredSessions.add(session);
      this.pinnedSessions.add(new WeakRef(session));
    }
    // Fail closed during a refresh and if the replacement pin cannot be read.
    session.setCertificateVerifyProc((_request, callback) => callback(-2));
    const expected = await this.getPinnedFingerprint();
    session.setCertificateVerifyProc((request, callback) => {
      callback(verifyVaultCertificate(request.hostname, request.certificate.data, expected) ? 0 : -2);
    });
  }

  private async readPinnedFingerprint(): Promise<string> {
    const value = normalizeFingerprint(await this.readFingerprintFile());
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Vault TLS fingerprint is missing or invalid');
    return value;
  }

  private async getPinnedFingerprint(): Promise<string> {
    for (;;) {
      const pending = this.pinnedFingerprint ??= this.readPinnedFingerprint();
      try {
        const value = await pending;
        // Provisioning can replace the pin while an initial disk read is pending.
        if (pending === this.pinnedFingerprint) return value;
      } catch (error) {
        if (pending === this.pinnedFingerprint) this.pinnedFingerprint = undefined;
        throw error;
      }
    }
  }
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').trim().toLowerCase();
}

/** The process-wide pin service. Holds no I/O until a session is configured. */
export const vaultTlsPins = new VaultTlsPinService();

/** Compatibility seam for existing callers; prefer `vaultTlsPins.refresh()`. */
export function refreshVaultPinnedSessions(): Promise<void> {
  return vaultTlsPins.refresh();
}

/** Compatibility seam for existing callers; prefer `vaultTlsPins.configureSession()`. */
export function configureVaultPinnedSession(session: Electron.Session): Promise<void> {
  return vaultTlsPins.configureSession(session);
}
