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
import { desktopFilesTransport, FilesTransportFailureClassifier, SullaFilesUnreachableError } from '../agent/files/desktopFilesTransport';

export const FILES_HTTPS_ORIGIN = loopbackOrigin('https', 30124);
const SESSION_PARTITION = 'sulla-files-service';
const RETRY_TIMEOUT_MS = 1_500;

interface PinnedFilesSession {
  fetch(input:string, init?:RequestInit):Promise<Response>;
  closeAllConnections():Promise<void> | void;
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
  private readonly sessionPool = new SullaFilesSessionPool<Electron.Session>(async() => {
    const session = Electron.session.fromPartition(SESSION_PARTITION, { cache: false });
    await this.configure(session);
    return session;
  }, () => desktopFilesTransport.notifyReset());

  private async readFingerprint():Promise<string> {
    const value = (await fs.readFile(path.join(paths.appHome, 'files-tls-fingerprint'), 'utf8')).replaceAll(':', '').trim().toLowerCase();
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
  await Promise.all([this.pinnedFingerprint, ...updates]);
}

  /** Dedicated pinned Electron transport for local Files requests. */
  async desktopFilesFetch(input:string | URL, init?:RequestInit):Promise<Response> {
    const url = new URL(input);
    if (url.origin !== FILES_HTTPS_ORIGIN) throw new Error('Pinned Files transport rejected a nonlocal destination');
    return this.sessionPool.fetch(url.toString(), init);
  }

  /** Drop only Chromium's sockets; the session and certificate pin stay intact. */
  async resetConnections():Promise<void> {
    await this.sessionPool.resetConnections();
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
