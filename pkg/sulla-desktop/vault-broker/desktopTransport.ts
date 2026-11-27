// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';

import { Agent, fetch as undiciFetch } from 'undici';

import Electron from 'electron';

import { loopbackOrigin } from '@pkg/utils/instance';
import paths from '@pkg/utils/paths';

import { PinnedNodeAgentFactory } from './PinnedNodeAgentFactory';
import type { VaultBrokerFetch, VaultBrokerServiceIdentity } from './index';

const BROKER_TOKEN_FILE = 'vault-broker-token.enc';
const APPROVAL_TOKEN_FILE = 'vault-approval-token.enc';
const BROKER_SERVICE_ID = 'sulla-tools';
const APPROVAL_SERVICE_ID = 'sulla-desktop-approval';
const SESSION_PARTITION = 'sulla-vault-broker';
// Electron fallback preserves separate cookie/cache and socket pools; Node uses isolated Agents without Electron session state.
const CONTROL_SESSION_PARTITION = 'sulla-vault-broker-control';
// Dedicated short-call capacity keeps lookups and metadata off the stream pool.
const VAULT_CONTROL_CONNECTIONS = 128;
// Headroom for the 300 simultaneous provider streams this transport must support.
const VAULT_STREAM_CONNECTIONS = 512;
const IDENTITY_TTL_MS = 60_000;

type VaultNodeAgentFactory = (options: Agent.Options) => Agent;
type VaultTlsPeerVerifier = (hostname: string, certificatePem: string) => Promise<boolean>;

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

/** Pinned Node vault transports with Electron-session fallbacks. */
export class DesktopVaultTransport {
  private pinnedSession: Promise<Electron.Session> | undefined;
  private controlSession: Promise<Electron.Session> | undefined;
  private nodeControlDispatcher: Agent | undefined;
  private nodeStreamDispatcher: Agent | undefined;
  private loggedControlTransport = false;
  private loggedStreamTransport = false;
  private readonly nodeFetch: typeof undiciFetch;
  private readonly dispatcherFactory: VaultNodeAgentFactory;
  private readonly nodeAgents: PinnedNodeAgentFactory;

  constructor(
    private readonly identities: DesktopVaultIdentityRepository = new DesktopVaultIdentityRepository(),
    private readonly sessionFactory: (partition: string) => Electron.Session = partition => Electron.session.fromPartition(partition, { cache: false }),
    private readonly pinSession: (session: Electron.Session) => Promise<void> = async(session) => {
      // Loaded only in Electron main. Keeping this require lazy avoids importing
      // Electron-only TLS code when the same broker package starts in tools.
      const { configureVaultPinnedSession } = await import('@pkg/main/vaultTls');
      await configureVaultPinnedSession(session);
    },
    nodeFetch: typeof undiciFetch = undiciFetch,
    dispatcherFactory?: VaultNodeAgentFactory,
    private readonly tlsConnect: typeof tls.connect = tls.connect,
    private readonly peerVerifier?: VaultTlsPeerVerifier,
  ) {
    this.nodeFetch = nodeFetch;
    this.dispatcherFactory = dispatcherFactory ?? (options => new Agent(options));
    this.nodeAgents = new PinnedNodeAgentFactory(this.dispatcherFactory, this.tlsConnect);
  }

  readonly fetch: VaultBrokerFetch = async(input, init) => {
    const useElectron = process.env.SULLA_VAULT_CONTROL_TRANSPORT === 'electron';
    if (!this.loggedControlTransport) {
      this.loggedControlTransport = true;
      console.info(`[vault-broker] control transport: ${ useElectron ? 'electron' : 'node-pinned' }`);
    }
    this.assertVaultOrigin(input, 'control');
    const response = useElectron ? await this.fetchWithElectron(input, init) : await this.nodeFetch(input, {
      ...init,
      dispatcher: this.nodeControlDispatcher ??= this.createNodeDispatcher(VAULT_CONTROL_CONNECTIONS),
    } as never) as unknown as Response;
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
    this.assertVaultOrigin(input, 'stream');
    if (!useElectron) {
      const response = await this.nodeFetch(input, {
        ...init,
        dispatcher: this.nodeStreamDispatcher ??= this.createNodeDispatcher(VAULT_STREAM_CONNECTIONS),
      } as never);
      if (response.status === 401 || response.status === 423) this.identities.invalidate();
      return response as unknown as Response;
    }
    const session = await this.getPinnedSession(false);

    const response = await session.fetch(input, init);
    if (response.status === 401 || response.status === 423) this.identities.invalidate();
    return response;
  };

  private createNodeDispatcher(connections: number): Agent {
    return this.nodeAgents.create(
      connections,
      (hostname, certificatePem) => this.verifyPeer(hostname, certificatePem),
      'Vault TLS certificate pin verification failed',
    );
  }

  private assertVaultOrigin(input: string, transport: 'control' | 'stream'): void {
    // Resolved per call because configureInstancePorts() remaps offset instances.
    if (new URL(input).origin !== loopbackOrigin('https', 30135)) {
      throw new Error(`Vault ${ transport } transport only accepts the local vault origin`);
    }
  }

  private async verifyPeer(hostname: string, certificatePem: string): Promise<boolean> {
    if (this.peerVerifier) return this.peerVerifier(hostname, certificatePem);
    // Loaded lazily so non-Electron callers do not initialize main-process TLS state.
    const { vaultTlsPins } = require('@pkg/main/vaultTls') as typeof import('@pkg/main/vaultTls');
    return vaultTlsPins.verifyPeer(hostname, certificatePem);
  }

  private async fetchWithElectron(input: string, init?: RequestInit): Promise<Response> {
    const pathname = new URL(input).pathname;
    const execution = pathname === '/v1/broker/execute' || pathname === '/v1/broker/execute-stream' ||
      /^\/v1\/broker\/relay\/[^/]+\/events$/.test(pathname);
    const session = await this.getPinnedSession(!execution);
    return session.fetch(input, init);
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
