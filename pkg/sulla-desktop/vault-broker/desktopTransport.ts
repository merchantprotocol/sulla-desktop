// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';

import { Agent, fetch as undiciFetch } from 'undici';

import Electron from 'electron';

import paths from '@pkg/utils/paths';

import type { VaultBrokerFetch, VaultBrokerServiceIdentity } from './index';

const BROKER_TOKEN_FILE = 'vault-broker-token.enc';
const APPROVAL_TOKEN_FILE = 'vault-approval-token.enc';
const BROKER_SERVICE_ID = 'sulla-tools';
const APPROVAL_SERVICE_ID = 'sulla-desktop-approval';
const SESSION_PARTITION = 'sulla-vault-broker';
const CONTROL_SESSION_PARTITION = 'sulla-vault-broker-control';
const IDENTITY_TTL_MS = 60_000;

/** Reads the OS-protected service identities the runtime writes when it starts the vault. */
export class DesktopVaultIdentityRepository {
  private readonly cache = new Map<string, { identity: VaultBrokerServiceIdentity; mtimeMs: number; expiresAt: number }>();
  // Resolved on each call so nothing touches Electron or the app home at construction.
  constructor(
    private readonly safeStorage: () => Electron.SafeStorage = () => Electron.safeStorage,
    private readonly appHome: () => string = () => paths.appHome,
    private readonly readFile: (filePath: string) => Promise<Buffer> = filePath => fs.readFile(filePath),
    private readonly statFile: (filePath: string) => Promise<{ mtimeMs: number }> = filePath => fs.stat(filePath),
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
    const filePath = path.join(this.appHome(), fileName);
    let mtimeMs: number;
    try {
      mtimeMs = (await this.statFile(filePath)).mtimeMs;
    } catch (error) {
      // The runtime writes these identities when it starts the vault. Before that
      // (first launch, startup still running or failed) there is nothing to read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Sulla is still starting its password vault. Wait for startup to finish, then try again.');
      }
      throw error;
    }
    const cached = this.cache.get(fileName);
    if (cached && cached.mtimeMs === mtimeMs && cached.expiresAt > Date.now()) return cached.identity;
    const encrypted = await this.readFile(filePath);
    const serviceToken = safeStorage.decryptString(encrypted);
    if (!serviceToken) throw new Error('Vault service identity is empty');

    const identity = { serviceId, serviceToken };
    this.cache.set(fileName, { identity, mtimeMs, expiresAt: Date.now() + IDENTITY_TTL_MS });
    return identity;
  }

  invalidate(): void { this.cache.clear(); }
}

/** Electron net transport pinned to the locally provisioned vault certificate. */
export class DesktopVaultTransport {
  private pinnedSession: Promise<Electron.Session> | undefined;
  private controlSession: Promise<Electron.Session> | undefined;
  private nodeStreamDispatcher: Agent | undefined;
  private loggedStreamTransport = false;
  private readonly nodeFetch: typeof undiciFetch;
  private readonly dispatcherFactory: () => Agent;

  constructor(
    private readonly identities: DesktopVaultIdentityRepository = new DesktopVaultIdentityRepository(),
    private readonly sessionFactory: (partition: string) => Electron.Session = partition => Electron.session.fromPartition(partition, { cache: false }),
    private readonly pinSession: (session: Electron.Session) => Promise<void> = async(session) => {
      // Loaded only in Electron main. Keeping this require lazy avoids importing
      // Electron-only TLS code when the same broker package starts in tools.
      const { configureVaultPinnedSession } = require('@pkg/main/vaultTls') as {
        configureVaultPinnedSession(session: Electron.Session): Promise<void>;
      };
      await configureVaultPinnedSession(session);
    },
    nodeFetch: typeof undiciFetch = undiciFetch,
    dispatcherFactory?: () => Agent,
  ) {
    this.nodeFetch = nodeFetch;
    this.dispatcherFactory = dispatcherFactory ?? (() => this.createNodeStreamDispatcher());
  }

  readonly fetch: VaultBrokerFetch = async(input, init) => {
    const session = await this.getPinnedSession(true);
    const response = await session.fetch(input, init);
    if (response.status === 401 || response.status === 423) this.identities.invalidate();
    return response;
  };

  /** Explicit route for any caller whose response body remains open as a stream. */
  readonly fetchStream: VaultBrokerFetch = async(input, init) => {
    const useElectron = process.env.SULLA_VAULT_STREAM_TRANSPORT === 'electron';
    if (!this.loggedStreamTransport) {
      this.loggedStreamTransport = true;
      console.info(`[vault-broker] stream transport: ${useElectron ? 'electron' : 'node-pinned'}`);
    }
    if (!useElectron) {
      const target = new URL(input);
      if (target.protocol !== 'https:' || target.hostname !== '127.0.0.1' || target.port !== '30135') {
        throw new Error('Vault stream transport only accepts the local vault origin');
      }
      const response = await this.nodeFetch(input, {
        ...init,
        dispatcher: this.nodeStreamDispatcher ??= this.dispatcherFactory(),
      } as never);
      if (response.status === 401 || response.status === 423) this.identities.invalidate();
      return response as unknown as Response;
    }
    const session = await this.getPinnedSession(false);

    const response = await session.fetch(input, init);
    if (response.status === 401 || response.status === 423) this.identities.invalidate();
    return response;
  };

  private createNodeStreamDispatcher(): Agent {
    return new Agent({
      connections: 64,
      connect: (options, callback) => {
        const socket = tls.connect({ ...options, host: options.hostname, rejectUnauthorized: false });
        let settled = false;
        const finish = (error: Error | null, connected?: tls.TLSSocket) => {
          if (settled) return;
          settled = true;
          callback(error, connected);
        };
        socket.once('error', error => finish(error, null));
        socket.once('secureConnect', () => {
          void (async() => {
            const certificate = socket.getPeerCertificate(true);
            const raw = certificate.raw;
            const hostname = typeof options.hostname === 'string' ? options.hostname : '';
            const pem = raw ? `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----` : '';
            const { vaultTlsPins } = require('@pkg/main/vaultTls') as typeof import('@pkg/main/vaultTls');
            if (!pem || !await vaultTlsPins.verifyPeer(hostname, pem)) {
              socket.destroy();
              finish(new Error('Vault TLS certificate pin verification failed'), null);
              return;
            }
            finish(null, socket);
          })().catch((error) => {
            socket.destroy();
            finish(error as Error, null);
          });
        });
        return socket;
      },
    });
  }

  loadBrokerIdentity(): Promise<VaultBrokerServiceIdentity> {
    return this.identities.loadBrokerIdentity();
  }

  loadApprovalIdentity(): Promise<VaultBrokerServiceIdentity> {
    return this.identities.loadApprovalIdentity();
  }

  private getPinnedSession(control: boolean): Promise<Electron.Session> {
    const slot = control ? 'controlSession' : 'pinnedSession';
    this[slot] ??= this.createPinnedSession(control).catch((error) => {
      this[slot] = undefined;
      throw error;
    });

    return this[slot]!;
  }

  private async createPinnedSession(control: boolean): Promise<Electron.Session> {
    if (!Electron.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-protected vault broker identity is unavailable');
    }
    const session = this.sessionFactory(control ? CONTROL_SESSION_PARTITION : SESSION_PARTITION);
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
