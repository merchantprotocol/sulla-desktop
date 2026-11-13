// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import path from 'node:path';

import Electron from 'electron';

import { PinnedVaultDispatcher } from './pinnedVaultDispatcher';

import { vaultCertificateMetadataMatches } from '@pkg/main/vaultTlsVerifier';
import paths from '@pkg/utils/paths';

import type { VaultBrokerFetch, VaultBrokerServiceIdentity } from './index';

const BROKER_TOKEN_FILE = 'vault-broker-token.enc';
const APPROVAL_TOKEN_FILE = 'vault-approval-token.enc';
const BROKER_SERVICE_ID = 'sulla-tools';
const APPROVAL_SERVICE_ID = 'sulla-desktop-approval';

let pinnedDispatcher: PinnedVaultDispatcher | undefined;

function getPinnedDispatcher(): PinnedVaultDispatcher {
  if (!pinnedDispatcher) {
    // Loaded only in Electron main. Keeping this require here avoids importing
    // Electron-only TLS code when the same broker package starts in tools.
    const { getPinnedFingerprint } = require('@pkg/main/vaultTls') as { getPinnedFingerprint(): Promise<string> };
    pinnedDispatcher = new PinnedVaultDispatcher({ fingerprint: getPinnedFingerprint, verify: vaultCertificateMetadataMatches });
  }
  return pinnedDispatcher;
}

/** Decrypt for the duration of one request; never persist plaintext identity. */
export async function loadDesktopBrokerIdentity(): Promise<VaultBrokerServiceIdentity> {
  return loadDesktopIdentity(BROKER_TOKEN_FILE, BROKER_SERVICE_ID);
}

export async function loadDesktopApprovalIdentity(): Promise<VaultBrokerServiceIdentity> {
  return loadDesktopIdentity(APPROVAL_TOKEN_FILE, APPROVAL_SERVICE_ID);
}

async function loadDesktopIdentity(fileName: string, serviceId: string): Promise<VaultBrokerServiceIdentity> {
  if (!Electron.safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-protected vault service identity is unavailable');
  }
  let encrypted: Buffer;
  try {
    encrypted = await fs.readFile(path.join(paths.appHome, fileName));
  } catch (error) {
    // The runtime writes these identities when it starts the vault. Before that
    // (first launch, startup still running or failed) there is nothing to read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Sulla is still starting its password vault. Wait for startup to finish, then try again.');
    }
    throw error;
  }
  const serviceToken = Electron.safeStorage.decryptString(encrypted);
  if (!serviceToken) throw new Error('Vault service identity is empty');
  return { serviceId, serviceToken };
}

/**
 * Pinned Node transport to the local vault. Not Electron `session.fetch`:
 * Chromium's 6-sockets-per-host limit let six streaming provider calls block
 * every other vault request (see PinnedVaultDispatcher).
 */
export const desktopVaultFetch: VaultBrokerFetch = async(input, init) => {
  if (!Electron.safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-protected vault broker identity is unavailable');
  }
  return getPinnedDispatcher().fetch(input, init);
};
