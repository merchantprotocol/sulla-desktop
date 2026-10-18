import fs from 'node:fs/promises';
import path from 'node:path';

import Electron from 'electron';

import paths from '@pkg/utils/paths';

import type { VaultBrokerFetch, VaultBrokerServiceIdentity } from './index';

const BROKER_TOKEN_FILE = 'vault-broker-token.enc';
const APPROVAL_TOKEN_FILE = 'vault-approval-token.enc';
const BROKER_SERVICE_ID = 'sulla-tools';
const APPROVAL_SERVICE_ID = 'sulla-desktop-approval';
const SESSION_PARTITION = 'sulla-vault-broker';

let pinnedSession: Promise<Electron.Session> | undefined;

async function getPinnedSession(): Promise<Electron.Session> {
  pinnedSession ??= (async() => {
    if (!Electron.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-protected vault broker identity is unavailable');
    }
    const session = Electron.session.fromPartition(SESSION_PARTITION, { cache: false });
    // Loaded only in Electron main. Keeping this require here avoids importing
    // Electron-only TLS code when the same broker package starts in tools.
    const { configureVaultPinnedSession } = require('@pkg/main/vaultTls') as {
      configureVaultPinnedSession(session: Electron.Session): Promise<void>;
    };
    await configureVaultPinnedSession(session);
    return session;
  })();
  try {
    return await pinnedSession;
  } catch (error) {
    pinnedSession = undefined;
    throw error;
  }
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
  const encrypted = await fs.readFile(path.join(paths.appHome, fileName));
  const serviceToken = Electron.safeStorage.decryptString(encrypted);
  if (!serviceToken) throw new Error('Vault service identity is empty');
  return { serviceId, serviceToken };
}

/** Electron net transport pinned to the locally provisioned vault certificate. */
export const desktopVaultFetch: VaultBrokerFetch = async(input, init) => {
  const session = await getPinnedSession();
  return session.fetch(input, init);
};
