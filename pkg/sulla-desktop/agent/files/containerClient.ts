// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';

import { Agent, fetch as undiciFetch } from 'undici';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import { issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import { sullaFilesCapabilityKey } from '@pkg/runtime/sullaFilesKey';

import type { ToolExecutionContext } from '../tools/executionContext';
import { desktopFilesTransport, FilesTransportFailureClassifier, SullaFilesUnreachableError } from './desktopFilesTransport';
import { loopbackOrigin } from '@pkg/utils/instance';

const DESKTOP_FILES_ORIGIN = loopbackOrigin('https', 30124);
const CONTAINER_FILES_ORIGIN = 'https://sulla_files:8792';
const MAX_CA_BYTES = 64 * 1_024;
const PRINCIPAL_CACHE_TTL_MS = 60_000;
const LOCAL_IDENTITY_TIMEOUT_MS = 1_500;
const FILES_REQUEST_TIMEOUT_MS = 30_000;

type FilesFetch = (input:string | URL, init?:RequestInit) => Promise<Response>;

export interface FilesApi {
  api: URL;
  request: FilesFetch;
}

export interface FilesContainerClientDependencies {
  resolveApi:() => FilesApi;
  getServicePassword:() => Promise<string>;
  subscribeTransportReset:(listener:() => void) => () => void;
  now:() => number;
  identityTimeoutMs:number;
  requestTimeoutMs:number;
}

let containerDispatcher:Promise<Agent> | undefined;

export type FilesCallerContext = Partial<Pick<ToolExecutionContext, 'sub' | 'org_id' | 'group_ids' | 'agent_id' | 'job_id' | 'thread_id' | 'device_id'>>;

function filesApi():FilesApi {
  // Standalone SULLA_FILES_SERVER_URL traffic is owned by SullaFilesWatcher;
  // this local client must never send local identity authority to that origin.
  const url = new URL(process.env.SULLA_FILES_API_URL || DESKTOP_FILES_ORIGIN);
  if (url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Sulla Files agent API must use the trusted local service origin');
  }
  if (url.origin === DESKTOP_FILES_ORIGIN) return { api: url, request: desktopFilesFetch };
  if (url.origin === CONTAINER_FILES_ORIGIN) return { api: url, request: containerFilesFetch };
  throw new Error('Sulla Files agent API must use the trusted local service origin');
}

const desktopFilesFetch:FilesFetch = async(input, init) => {
  // Desktop main registers its pinned-TLS transport; the Tools container never does, so it fails closed there.
  const transport = desktopFilesTransport.resolve();
  if (transport.origin !== DESKTOP_FILES_ORIGIN) throw new Error('Files Desktop TLS origin is inconsistent');
  return transport.fetch(input, init);
};

async function readContainerCa():Promise<string> {
  const caPath = process.env.SULLA_FILES_TLS_CA_FILE;
  if (!caPath) throw new Error('SULLA_FILES_TLS_CA_FILE is required for the Files container transport');
  const handle = await fs.open(caPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CA_BYTES) throw new Error('Files TLS CA is missing or invalid');
    const ca = await handle.readFile('utf8');
    if (Buffer.byteLength(ca) > MAX_CA_BYTES || !ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----')) {
      throw new Error('Files TLS CA is missing or invalid');
    }
    return ca;
  } finally {
    await handle.close();
  }
}

async function getContainerDispatcher():Promise<Agent> {
  containerDispatcher ??= readContainerCa().then(ca => new Agent({ connect: { ca } }));
  try {
    return await containerDispatcher;
  } catch (error) {
    containerDispatcher = undefined;
    throw error;
  }
}

const containerFilesFetch:FilesFetch = async(input, init) => {
  if (new URL(input).origin !== CONTAINER_FILES_ORIGIN) throw new Error('Files container transport rejected an untrusted origin');
  return undiciFetch(input, {
    ...init,
    dispatcher: await getContainerDispatcher(),
  } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
};

/** A per-client, short-lived cache for the local Files identity endpoint. */
export class FilesContainerClient {
  private principal?:{ id:string; expiresAt:number };
  private principalGeneration = 0;
  private principalLookup?:{ generation:number; promise:Promise<string> };
  private readonly dependencies:FilesContainerClientDependencies;
  private readonly removeResetListener:() => void;

  constructor(dependencies:Partial<FilesContainerClientDependencies> = {}) {
    this.dependencies = {
      resolveApi:             filesApi,
      getServicePassword:     async() => process.env.SULLA_FILES_CAPABILITY_SECRET || SullaSettingsModel.getServicePassword(),
      subscribeTransportReset: listener => desktopFilesTransport.onReset(listener),
      now:                    Date.now,
      identityTimeoutMs:      LOCAL_IDENTITY_TIMEOUT_MS,
      requestTimeoutMs:       FILES_REQUEST_TIMEOUT_MS,
      ...dependencies,
    };
    this.removeResetListener = this.dependencies.subscribeTransportReset(() => this.invalidatePrincipal());
  }

  dispose():void {
    this.removeResetListener();
    this.invalidatePrincipal();
  }

  invalidatePrincipal():void {
    this.principal = undefined;
    this.principalGeneration += 1;
    this.principalLookup = undefined;
  }

  async request(path:string, context:FilesCallerContext, init:RequestInit = {}):Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Files endpoint must be service-relative');
    const { api, request } = this.dependencies.resolveApi();
    const target = new URL(path, api);
    if (target.origin !== api.origin) throw new Error('Files endpoint must use the trusted local service origin');

    // Desktop supplies its established service secret; the Tools container has no settings DB.
    const servicePassword = await this.dependencies.getServicePassword();
    // Files owns identity. A tool context's subject is never trusted for caller identification.
    const sub = await this.localPrincipal(api, request, servicePassword);
    const token = issueCapabilityToken({ ...context, sub, scopes: ['files/*'], expiresInSeconds: 300 }, sullaFilesCapabilityKey(servicePassword));
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${ token }`);
    if (init.body) headers.set('content-type', 'application/json');

    const response = await this.requestOrThrow(request, target, {
      ...init,
      headers,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(this.dependencies.requestTimeoutMs),
    });
    if (response.status === 401) this.invalidatePrincipal();
    if (!response.ok) {
      const body = await response.clone().json().catch(() => ({})) as { error?: unknown };
      throw new Error(typeof body.error === 'string' && body.error ? body.error : `Sulla Files returned ${ response.status }`);
    }
    return response;
  }

  async json<T>(path:string, context:FilesCallerContext, init:RequestInit = {}):Promise<T> {
    const response = await this.request(path, context, init);
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }

  private async localPrincipal(api:URL, request:FilesFetch, servicePassword:string):Promise<string> {
    if (this.principal && this.principal.expiresAt > this.dependencies.now()) return this.principal.id;
    const generation = this.principalGeneration;
    if (this.principalLookup?.generation === generation) return this.principalLookup.promise;

    const lookup = this.resolveLocalPrincipal(api, request, servicePassword, generation);
    this.principalLookup = { generation, promise: lookup };
    try {
      return await lookup;
    } finally {
      if (this.principalLookup?.promise === lookup) this.principalLookup = undefined;
    }
  }

  private async resolveLocalPrincipal(api:URL, request:FilesFetch, servicePassword:string, generation:number):Promise<string> {
    const identityUrl = new URL('/v1/local/identity', api);
    const response = await this.requestOrThrow(request, identityUrl, {
      headers:  { 'x-sulla-files-token': servicePassword },
      redirect: 'error',
      signal:   AbortSignal.timeout(this.dependencies.identityTimeoutMs),
    });
    if (response.status === 401) this.invalidatePrincipal();
    if (!response.ok) throw new Error('Sulla Files could not resolve the local principal');
    const body = await response.json() as { principalId?: unknown };
    if (typeof body.principalId !== 'string' || !body.principalId) throw new Error('Sulla Files returned an invalid local principal');
    if (generation === this.principalGeneration) this.principal = { id: body.principalId, expiresAt: this.dependencies.now() + PRINCIPAL_CACHE_TTL_MS };
    return body.principalId;
  }

  private async requestOrThrow(request:FilesFetch, input:string | URL, init:RequestInit):Promise<Response> {
    try {
      return await request(input, init);
    } catch (error) {
      const reason = FilesTransportFailureClassifier.reason(error);
      if (!reason || error instanceof SullaFilesUnreachableError) throw error;
      throw new SullaFilesUnreachableError(reason, error);
    }
  }
}

const filesContainerClient = new FilesContainerClient();

export function filesContainerRequest(path:string, context:FilesCallerContext, init:RequestInit = {}):Promise<Response> {
  return filesContainerClient.request(path, context, init);
}

export function filesContainerJson<T>(path:string, context:FilesCallerContext, init:RequestInit = {}):Promise<T> {
  return filesContainerClient.json<T>(path, context, init);
}
