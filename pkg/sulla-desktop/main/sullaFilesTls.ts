// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import path from 'node:path';

import Electron from 'electron';
import { Agent, fetch as undiciFetch } from 'undici';

import { VaultTlsPinService, verifyVaultCertificate } from './vaultTls';

import paths from '@pkg/utils/paths';
import { loopbackOrigin } from '@pkg/utils/instance';
import { PinnedNodeAgentFactory } from '@pkg/vault-broker/PinnedNodeAgentFactory';
import { desktopFilesTransport, FilesTransportFailureClassifier, SullaFilesUnreachableError } from '../agent/files/desktopFilesTransport';
import { FilesTransportConcurrencyMeter, type FilesTransportConcurrencySnapshot } from '../agent/files/FilesTransportConcurrencyMeter';

export const FILES_HTTPS_ORIGIN = loopbackOrigin('https', 30124);
const SESSION_PARTITION = 'sulla-files-service';
const RETRY_TIMEOUT_MS = 1_500;
const FILES_NODE_CONNECTIONS = 64;
// Chromium's per-host HTTP socket group is capped at six. Keep this explicit in the rollback path
// so its queue and wait measurements remain observable rather than hidden inside Electron.
const ELECTRON_FILES_CONNECTIONS = 6;

interface PinnedFilesSession {
  fetch(input:string, init?:RequestInit):Promise<Response>;
  closeAllConnections():Promise<void> | void;
}

export interface SullaFilesTlsDependencies {
  createSession:() => Promise<PinnedFilesSession>;
  readFingerprintFile:() => Promise<string>;
  nodeFetch:typeof undiciFetch;
  nodeAgentFactory:PinnedNodeAgentFactory;
  nodeConnections:number;
}

/** Owns the single pinned Chromium session and recovers stale keep-alive pools. */
export class SullaFilesSessionPool<TSession extends PinnedFilesSession> {
  private session?:Promise<TSession>;

  constructor(
    private readonly createSession:() => Promise<TSession>,
    private readonly onReset:() => void,
    private readonly retryTimeoutMs = RETRY_TIMEOUT_MS,
  ) {}

  async fetch(input:string, init?:RequestInit):Promise<Response> {
    const session = await this.getSession();
    try {
      return await session.fetch(input, init);
    } catch (error) {
      const method = (init?.method ?? 'GET').toUpperCase();
      // Only GET/HEAD are retried: the failed write may already have reached Files,
      // and this transport has no server receipt proving an unsafe request was not applied.
      const failureReason = FilesTransportFailureClassifier.reason(error) ?? FilesTransportFailureClassifier.reason(init?.signal?.reason);
      if (!failureReason) throw error;

      try {
        await this.resetConnections();
      } catch (resetError) {
        throw new SullaFilesUnreachableError(FilesTransportFailureClassifier.reason(resetError) ?? 'connection reset failed', resetError);
      }
      if (method !== 'GET' && method !== 'HEAD') throw error;

      const retrySignal = this.retrySignal(init?.signal);
      try {
        return await session.fetch(input, { ...init, signal: retrySignal });
      } catch (retryError) {
        const reason = FilesTransportFailureClassifier.reason(retryError) ?? FilesTransportFailureClassifier.reason(retrySignal.reason);
        if (reason) throw new SullaFilesUnreachableError(reason, retryError);
        throw retryError;
      }
    }
  }

  async resetConnections():Promise<void> {
    const sessionPromise = this.session;
    if (!sessionPromise) return;
    try {
      await (await sessionPromise).closeAllConnections();
    } finally {
      this.onReset();
    }
  }

  private async getSession():Promise<TSession> {
    this.session ??= this.createSession().catch((error) => {
      this.session = undefined;
      throw error;
    });
    return this.session;
  }

  private retrySignal(signal?:AbortSignal | null):AbortSignal {
    const deadline = AbortSignal.timeout(this.retryTimeoutMs);
    return signal && !signal.aborted ? AbortSignal.any([signal, deadline]) : deadline;
  }
}

export class SullaFilesTlsService {
  private pinnedFingerprint?:Promise<string>;
  private readonly sessions = new Set<WeakRef<Electron.Session>>();
  private readonly registeredSessions = new WeakSet<Electron.Session>();
  private readonly sessionPool:SullaFilesSessionPool<PinnedFilesSession>;
  private readonly certificatePins:VaultTlsPinService;
  private readonly readFingerprintFile:() => Promise<string>;
  private readonly nodeFetch:typeof undiciFetch;
  private readonly nodeAgentFactory:PinnedNodeAgentFactory;
  private readonly nodeConnections:number;
  private nodeDispatcher?:Promise<Agent>;
  private readonly concurrencyMeter = new FilesTransportConcurrencyMeter(FILES_NODE_CONNECTIONS);

  constructor(dependencies:Partial<SullaFilesTlsDependencies> = {}) {
    const readFingerprintFile = dependencies.readFingerprintFile ?? (() => fs.readFile(path.join(paths.appHome, 'files-tls-fingerprint'), 'utf8'));
    this.readFingerprintFile = readFingerprintFile;
    // Reuse the existing loopback pin policy with Files' own fingerprint source.
    this.certificatePins = new VaultTlsPinService(readFingerprintFile);
    this.nodeFetch = dependencies.nodeFetch ?? undiciFetch;
    this.nodeAgentFactory = dependencies.nodeAgentFactory ?? new PinnedNodeAgentFactory();
    this.nodeConnections = dependencies.nodeConnections ?? FILES_NODE_CONNECTIONS;
    this.sessionPool = new SullaFilesSessionPool<PinnedFilesSession>(async() => {
      const session = await (dependencies.createSession ?? (async() => {
        const electronSession = Electron.session.fromPartition(SESSION_PARTITION, { cache: false });
        await this.configure(electronSession);
        return electronSession;
      }))();
      return session;
    }, () => desktopFilesTransport.notifyReset());
  }

  private async readFingerprint():Promise<string> {
    const value = (await this.readFingerprintFile()).replaceAll(':', '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Files TLS fingerprint is missing or invalid');
    return value;
  }

  private async configure(session:Electron.Session):Promise<void> {
  // Track each session once. refreshFilesPinnedSessions() re-runs configure() for every
  // tracked session, so registering again on each call doubled the set per refresh
  // (2^21 entries after 21 refreshes, then Promise.all threw and the app spun at 100% CPU).
  if (!this.registeredSessions.has(session)) {
    this.registeredSessions.add(session);
    this.sessions.add(new WeakRef(session));
  }
  session.setCertificateVerifyProc((_request, callback) => callback(-2));
  const expected = await (this.pinnedFingerprint ??= this.readFingerprint());
  session.setCertificateVerifyProc((request, callback) => {
    callback(verifyVaultCertificate(request.hostname, request.certificate.data, expected) ? 0 : -2);
  });
}

  async refreshFilesPinnedSessions():Promise<void> {
  this.pinnedFingerprint = this.readFingerprint();
  const updates:Promise<void>[] = [];
  for (const reference of this.sessions) {
    const session = reference.deref();
    if (session) updates.push(this.configure(session)); else this.sessions.delete(reference);
  }
  await Promise.all([this.pinnedFingerprint, this.certificatePins.refresh(), ...updates]);
}

  /** Dedicated pinned Electron transport for local Files requests. */
  async desktopFilesFetch(input:string | URL, init?:RequestInit):Promise<Response> {
    const url = new URL(input);
    if (url.origin !== FILES_HTTPS_ORIGIN) throw new Error('Pinned Files transport rejected a nonlocal destination');
    // SULLA_FILES_TRANSPORT=electron is the reversible fallback to the previous session path.
    const useElectron = process.env.SULLA_FILES_TRANSPORT === 'electron';
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = url.pathname.startsWith('/v1/') ? `/${ url.pathname.split('/').filter(Boolean).slice(0, 2).join('/') }` : '/other';
    const operation = `${ useElectron ? 'electron' : 'node' } ${ method } ${ route }`;
    const limit = useElectron ? ELECTRON_FILES_CONNECTIONS : this.nodeConnections;
    return this.concurrencyMeter.run(operation, () => useElectron
      ? this.sessionPool.fetch(url.toString(), init)
      : this.fetchWithNode(input, init), init?.signal, limit);
  }

  getConcurrencyMetrics():Record<string, FilesTransportConcurrencySnapshot> {
    return this.concurrencyMeter.snapshot();
  }

  /** Drop only Chromium's sockets; the session and certificate pin stay intact. */
  async resetConnections():Promise<void> {
    await this.sessionPool.resetConnections();
    const dispatcherPromise = this.nodeDispatcher;
    if (dispatcherPromise) await this.resetNodeDispatcher(dispatcherPromise);
  }

  private async fetchWithNode(input:string | URL, init?:RequestInit):Promise<Response> {
    const dispatcherPromise = this.getNodeDispatcher();
    try {
      return await this.nodeFetch(input, { ...init, dispatcher: await dispatcherPromise } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    } catch (error) {
      const failureReason = FilesTransportFailureClassifier.reason(error) ?? FilesTransportFailureClassifier.reason(init?.signal?.reason);
      if (!failureReason) throw error;
      await this.resetNodeDispatcher(dispatcherPromise);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw error;

      const retrySignal = this.retrySignal(init?.signal);
      try {
        return await this.nodeFetch(input, { ...init, signal: retrySignal, dispatcher: await this.getNodeDispatcher() } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      } catch (retryError) {
        const reason = FilesTransportFailureClassifier.reason(retryError) ?? FilesTransportFailureClassifier.reason(retrySignal.reason);
        if (reason) throw new SullaFilesUnreachableError(reason, retryError);
        throw retryError;
      }
    }
  }

  private getNodeDispatcher():Promise<Agent> {
    this.nodeDispatcher ??= Promise.resolve().then(() => this.nodeAgentFactory.create(
      this.nodeConnections,
      (hostname, certificatePem) => this.certificatePins.verifyPeer(hostname, certificatePem),
      'Files TLS certificate pin verification failed',
    )).catch((error) => {
      this.nodeDispatcher = undefined;
      throw error;
    });
    return this.nodeDispatcher;
  }

  private async resetNodeDispatcher(dispatcherPromise:Promise<Agent>):Promise<void> {
    if (this.nodeDispatcher !== dispatcherPromise) return;
    this.nodeDispatcher = undefined;
    try {
      await (await dispatcherPromise).destroy(new Error('Files transport connection reset'));
    } finally {
      desktopFilesTransport.notifyReset();
    }
  }

  private retrySignal(signal?:AbortSignal | null):AbortSignal {
    const deadline = AbortSignal.timeout(RETRY_TIMEOUT_MS);
    return signal && !signal.aborted ? AbortSignal.any([signal, deadline]) : deadline;
  }
}

export class SullaFilesTlsServiceProvider {
  private service?:SullaFilesTlsService;
  resolve():SullaFilesTlsService { return this.service ??= new SullaFilesTlsService(); }
}

export const sullaFilesTlsProvider = new SullaFilesTlsServiceProvider();
export async function refreshFilesPinnedSessions():Promise<void> { return sullaFilesTlsProvider.resolve().refreshFilesPinnedSessions() }
export async function desktopFilesFetch(input:string | URL, init?:RequestInit):Promise<Response> { return sullaFilesTlsProvider.resolve().desktopFilesFetch(input, init) }
export async function resetFilesPinnedSessionConnections():Promise<void> { return sullaFilesTlsProvider.resolve().resetConnections() }

// Hand the pinned-TLS Files transport to the agent-side Files client. Tools container never loads this module.
desktopFilesTransport.register({ origin: FILES_HTTPS_ORIGIN, fetch: desktopFilesFetch });
