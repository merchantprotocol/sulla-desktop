// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import os from 'node:os';

import { desktopFilesFetch, FILES_HTTPS_ORIGIN } from './sullaFilesTls';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';
import { NATIVE_SOURCE_MAX_PAGES, NATIVE_SOURCE_PAGE_SIZE, requestHeaders, type SullaFilesCapabilityContext } from './SullaFilesWatcherSupport';

export class SullaFilesWatcherRequestService {
  constructor(
    private readonly ensureUnlocked:() => Promise<void>,
    private readonly appUnlocked:() => Promise<boolean>,
    private readonly isStopped:() => boolean,
  ) {}

  async requireAppUnlocked():Promise<void> {
    if (this.isStopped() || !await this.appUnlocked()) throw new Error('Files is locked with the application');
  }

  async rawLocalRequest(endpoint:string, init:RequestInit = {}, timeoutMs = 30_000):Promise<Response> {
    const token = await SullaSettingsModel.getServicePassword();
    const headers = requestHeaders(init.headers, { 'x-sulla-files-token': token }, { 'content-type': 'application/json' });
    return desktopFilesFetch(`${ FILES_HTTPS_ORIGIN }${ endpoint }`, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  }

  async isLockedResponse(response:Response):Promise<boolean> {
    if (response.status !== 503) return false;
    const body = await response.clone().json().catch(() => ({}));
    return body.code === 'FILES_LOCKED';
  }

  async localRequest(endpoint:string, init:RequestInit):Promise<Response> {
    await this.ensureUnlocked();
    const response = await this.rawLocalRequest(endpoint, init);
    if (!await this.isLockedResponse(response)) return response;
    // A restart between the health check and request is safe to retry once:
    // locked services reject requests before executing any operation.
    await this.ensureUnlocked();
    return this.rawLocalRequest(endpoint, init);
  }

  async listNativeSources():Promise<{ fileId:string; versionId:string; path:string; handle:string; name:string; sourceRevision:string; sourceHash:string; state:string; lastError?:string; recovery:Record<string, unknown> }[]> {
    const response = await this.localRequest('/v1/local/native-sources', {});
    if (!response.ok) throw new Error(`Native source inventory failed (${ response.status })`);
    return response.json();
  }

  async listNativeSourcesRaw():Promise<{ fileId:string; versionId:string; path:string; handle:string; name:string; sourceRevision:string; sourceHash:string; state:string; lastError?:string; recovery:Record<string, unknown> }[]> {
    const all:Awaited<ReturnType<SullaFilesWatcherRequestService['listNativeSourcesRaw']>> = [];
    let after:string | undefined;
    for (let page = 0; page < NATIVE_SOURCE_MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(NATIVE_SOURCE_PAGE_SIZE) });
      if (after) query.set('after', after);
      const response = await this.rawLocalRequest(`/v1/local/native-sources?${ query }`);
      if (!response.ok) throw new Error(`Native source inventory failed (${ response.status })`);
      const rows = await response.json() as typeof all;
      all.push(...rows);
      after = response.headers.get('x-sulla-next-cursor') ?? undefined;
      // An older Files image ignores paging and returns everything without a cursor.
      if (!after || rows.length < NATIVE_SOURCE_PAGE_SIZE) break;
    }
    return all;
  }

  async localPrincipalId():Promise<string> {
    const response = await this.rawLocalRequest('/v1/local/identity');
    if (!response.ok) throw new Error('Files service identity is unavailable');
    const body = await response.json() as { principalId?: unknown };
    if (typeof body.principalId !== 'string' || !body.principalId) throw new Error('Files service returned an invalid identity');
    return body.principalId;
  }

  async capabilityToken(userId = process.env.SULLA_FILES_USER_ID ?? 'desktop-user', context:SullaFilesCapabilityContext = {}, scopes = ['files/*'], collectionId?:string):Promise<string> {
    const key = sullaFilesCapabilityKey(await SullaSettingsModel.getServicePassword());
    const now = Math.floor(Date.now() / 1_000);
    const encode = (value:string) => Buffer.from(value).toString('base64url');
    const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const deviceId = await getDesktopDeviceId().catch(() => os.hostname());
    const payload = encode(JSON.stringify({
      sub: userId, device_id: deviceId, scopes,
      agent_id: context.agentId, job_id: context.jobId, thread_id: context.threadId,
      ...(collectionId ? { collection_id: collectionId } : {}),
      v: 1, iss: 'sulla-files', aud: 'sulla-tools', iat: now, exp: now + 300, jti: crypto.randomUUID(),
    }));
    return `${ header }.${ payload }.${ crypto.createHmac('sha256', key).update(`${ header }.${ payload }`).digest('base64url') }`;
  }

  async fuseMountCredentials():Promise<{ token:string }> {
    await this.requireAppUnlocked();
    const principalId = await this.localPrincipalId();
    return { token: await this.capabilityToken(principalId, {}, ['files/fuse']) };
  }

  async requestFiles(endpoint:string, init:RequestInit = {}, server = false, capability:SullaFilesCapabilityContext = {}):Promise<Response> {
    const base = server && process.env.SULLA_FILES_SERVER_URL ? process.env.SULLA_FILES_SERVER_URL : FILES_HTTPS_ORIGIN;
    const url = new URL(endpoint, base);
    if (url.origin !== new URL(base).origin) throw new Error('Files endpoint must use the configured service');
    if (base !== FILES_HTTPS_ORIGIN) {
      const token = await this.capabilityToken(undefined, capability);
      const headers = requestHeaders(init.headers, { authorization: `Bearer ${ token }` });
      return fetch(url, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
    }
    await this.ensureUnlocked();
    let principalId = await this.localPrincipalId();
    const send = async() => {
      const token = await this.capabilityToken(principalId, capability);
      const headers = requestHeaders(init.headers, { authorization: `Bearer ${ token }` });
      return desktopFilesFetch(url, { ...init, headers, redirect: 'error' as const, signal: init.signal ?? AbortSignal.timeout(30_000) });
    };
    const response = await send();
    if (response.status !== 401 && !await this.isLockedResponse(response)) return response;
    await response.body?.cancel();
    await this.ensureUnlocked();
    principalId = await this.localPrincipalId();
    return send();
  }

  async requestNativeFiles(endpoint:string, init:RequestInit = {}):Promise<Response> {
    const url = new URL(endpoint, FILES_HTTPS_ORIGIN);
    if (url.origin !== new URL(FILES_HTTPS_ORIGIN).origin) throw new Error('Native Files endpoints must use the local service');
    await this.ensureUnlocked();
    let principalId = await this.localPrincipalId();
    const send = async() => {
      const [localToken, capability] = await Promise.all([SullaSettingsModel.getServicePassword(), this.capabilityToken(principalId)]);
      const headers = requestHeaders(init.headers, {
        'x-sulla-files-token': localToken, authorization: `Bearer ${ capability }`,
      }, init.body ? { 'content-type': 'application/json' } : {});
      return desktopFilesFetch(url, { ...init, headers, redirect: 'error' as const, signal: init.signal ?? AbortSignal.timeout(30_000) });
    };
    const response = await send();
    if (response.status !== 401 && !await this.isLockedResponse(response)) return response;
    await response.body?.cancel();
    await this.ensureUnlocked();
    principalId = await this.localPrincipalId();
    return send();
  }

  async requestFilesStream(endpoint:string, init:RequestInit = {}, signal?:AbortSignal):Promise<Response> {
    const url = new URL(endpoint, FILES_HTTPS_ORIGIN);
    if (url.origin !== new URL(FILES_HTTPS_ORIGIN).origin) throw new Error('Files endpoint must use the local service');
    await this.ensureUnlocked();
    let principalId = await this.localPrincipalId();
    const send = async() => {
      const token = await this.capabilityToken(principalId);
      const headers = requestHeaders(init.headers, { authorization: `Bearer ${ token }` });
      return desktopFilesFetch(url, { ...init, headers, redirect: 'error' as const, signal });
    };
    const response = await send();
    if (response.status !== 401 && !await this.isLockedResponse(response)) return response;
    await response.body?.cancel();
    await this.ensureUnlocked();
    principalId = await this.localPrincipalId();
    return send();
  }
}
