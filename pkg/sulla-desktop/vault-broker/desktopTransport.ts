// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

/** Reads the OS-protected service identities the runtime writes when it starts the vault. */
export class DesktopVaultIdentityRepository {
  // Resolved on each call so nothing touches Electron or the app home at construction.
  constructor(
    private readonly safeStorage: () => Electron.SafeStorage = () => Electron.safeStorage,
    private readonly appHome: () => string = () => paths.appHome,
    private readonly readFile: (filePath: string) => Promise<Buffer> = filePath => fs.readFile(filePath),
  ) {}

  /** Decrypt for the duration of one request; never persist plaintext identity. */
  loadBrokerIdentity(): Promise<VaultBrokerServiceIdentity> {
    return this.load(BROKER_TOKEN_FILE, BROKER_SERVICE_ID);
  }

  loadApprovalIdentity(): Promise<VaultBrokerServiceIdentity> {
    return this.load(APPROVAL_TOKEN_FILE, APPROVAL_SERVICE_ID);
  }

  private async load(fileName: string, serviceId: string): Promise<VaultBrokerServiceIdentity> {
    const safeStorage = this.safeStorage();
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-protected vault service identity is unavailable');
    }
    let encrypted: Buffer;
    try {
      encrypted = await this.readFile(path.join(this.appHome(), fileName));
    } catch (error) {
      // The runtime writes these identities when it starts the vault. Before that
      // (first launch, startup still running or failed) there is nothing to read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Sulla is still starting its password vault. Wait for startup to finish, then try again.');
      }
      throw error;
    }
    const serviceToken = safeStorage.decryptString(encrypted);
    if (!serviceToken) throw new Error('Vault service identity is empty');

    return { serviceId, serviceToken };
  }
}

/** Electron net transport pinned to the locally provisioned vault certificate. */
export class DesktopVaultTransport {
  private pinnedSession: Promise<Electron.Session> | undefined;

  constructor(
    private readonly identities: DesktopVaultIdentityRepository = new DesktopVaultIdentityRepository(),
    private readonly sessionFactory: () => Electron.Session = () => Electron.session.fromPartition(SESSION_PARTITION, { cache: false }),
    private readonly pinSession: (session: Electron.Session) => Promise<void> = async(session) => {
      // Loaded only in Electron main. Keeping this require lazy avoids importing
      // Electron-only TLS code when the same broker package starts in tools.
      const { configureVaultPinnedSession } = require('@pkg/main/vaultTls') as {
        configureVaultPinnedSession(session: Electron.Session): Promise<void>;
      };
      await configureVaultPinnedSession(session);
    },
  ) {}

  readonly fetch: VaultBrokerFetch = async(input, init) => {
    const session = await this.getPinnedSession();

    return session.fetch(input, init);
  };

  loadBrokerIdentity(): Promise<VaultBrokerServiceIdentity> {
    return this.identities.loadBrokerIdentity();
  }

  loadApprovalIdentity(): Promise<VaultBrokerServiceIdentity> {
    return this.identities.loadApprovalIdentity();
  }

  private getPinnedSession(): Promise<Electron.Session> {
    this.pinnedSession ??= this.createPinnedSession().catch((error) => {
      this.pinnedSession = undefined;
      throw error;
    });

    return this.pinnedSession;
  }

  private async createPinnedSession(): Promise<Electron.Session> {
    if (!Electron.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-protected vault broker identity is unavailable');
    }
    const session = this.sessionFactory();
    await this.pinSession(session);

    return session;
  }
}

/** The process-wide Desktop transport. Constructing it has no side effects. */
export const desktopVaultTransport = new DesktopVaultTransport();

/** Compatibility seams for existing callers; prefer the `desktopVaultTransport` instance. */
export const desktopVaultFetch: VaultBrokerFetch = desktopVaultTransport.fetch;

export function loadDesktopBrokerIdentity(): Promise<VaultBrokerServiceIdentity> {
  return desktopVaultTransport.loadBrokerIdentity();
}

export function loadDesktopApprovalIdentity(): Promise<VaultBrokerServiceIdentity> {
  return desktopVaultTransport.loadApprovalIdentity();
}
