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

export const FILES_HTTPS_ORIGIN = loopbackOrigin('https', 30124);
const SESSION_PARTITION = 'sulla-files-service';

export class SullaFilesTlsService {
  private pinnedFingerprint?:Promise<string>;
  private pinnedSession?:Promise<Electron.Session>;
  private readonly sessions = new Set<WeakRef<Electron.Session>>();
  private readonly registeredSessions = new WeakSet<Electron.Session>();

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

  private async getSession():Promise<Electron.Session> {
  this.pinnedSession ??= (async() => {
    const session = Electron.session.fromPartition(SESSION_PARTITION, { cache: false });
    await this.configure(session);
    return session;
  })();
  try { return await this.pinnedSession } catch (error) { this.pinnedSession = undefined; throw error }
}

  /** Dedicated pinned Electron transport for local Files requests. */
  async desktopFilesFetch(input:string | URL, init?:RequestInit):Promise<Response> {
  const url = new URL(input);
  if (url.origin !== FILES_HTTPS_ORIGIN) throw new Error('Pinned Files transport rejected a nonlocal destination');
  return (await this.getSession()).fetch(url.toString(), init);
}
}

export class SullaFilesTlsServiceProvider {
  private service?:SullaFilesTlsService;
  resolve():SullaFilesTlsService { return this.service ??= new SullaFilesTlsService(); }
}

export const sullaFilesTlsProvider = new SullaFilesTlsServiceProvider();
export async function refreshFilesPinnedSessions():Promise<void> { return sullaFilesTlsProvider.resolve().refreshFilesPinnedSessions() }
export async function desktopFilesFetch(input:string | URL, init?:RequestInit):Promise<Response> { return sullaFilesTlsProvider.resolve().desktopFilesFetch(input, init) }
