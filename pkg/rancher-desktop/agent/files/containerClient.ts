import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';

import { Agent, fetch as undiciFetch } from 'undici';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import { issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import { sullaFilesCapabilityKey } from '@pkg/runtime/sullaFilesKey';

import type { ToolExecutionContext } from '../tools/executionContext';

const DESKTOP_FILES_ORIGIN = 'https://127.0.0.1:30124';
const CONTAINER_FILES_ORIGIN = 'https://sulla_files:8792';
const MAX_CA_BYTES = 64 * 1_024;

type FilesFetch = (input:string | URL, init?:RequestInit) => Promise<Response>;

let containerDispatcher:Promise<Agent> | undefined;

export type FilesCallerContext = Partial<Pick<ToolExecutionContext, 'sub' | 'org_id' | 'group_ids' | 'agent_id' | 'job_id' | 'thread_id' | 'device_id'>>;

function filesApi():{ api: URL; request: FilesFetch } {
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
  // Keep Electron and Desktop-only paths out of the Node tools container.
  const transport = await import('@pkg/main/sullaFilesTls');
  if (transport.FILES_HTTPS_ORIGIN !== DESKTOP_FILES_ORIGIN) throw new Error('Files Desktop TLS origin is inconsistent');
  return transport.desktopFilesFetch(input, init);
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

async function localPrincipal(api:URL, request:FilesFetch, servicePassword:string):Promise<string> {
  const response = await request(new URL('/v1/local/identity', api), {
    headers:  { 'x-sulla-files-token': servicePassword },
    redirect: 'error',
    signal:   AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('Sulla Files could not resolve the local principal');
  const body = await response.json() as { principalId?: unknown };
  if (typeof body.principalId !== 'string' || !body.principalId) throw new Error('Sulla Files returned an invalid local principal');
  return body.principalId;
}

export async function filesContainerRequest(path:string, context:FilesCallerContext, init:RequestInit = {}):Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Files endpoint must be service-relative');
  const { api, request } = filesApi();
  const target = new URL(path, api);
  if (target.origin !== api.origin) throw new Error('Files endpoint must use the trusted local service origin');
  const servicePassword = await SullaSettingsModel.getServicePassword();
  // The Files service owns user identity. Never trust a caller-supplied subject
  // for local ACL decisions, including tool contexts restored from old threads.
  const sub = await localPrincipal(api, request, servicePassword);
  const token = issueCapabilityToken({ ...context, sub, scopes: ['files/*'], expiresInSeconds: 300 }, sullaFilesCapabilityKey(servicePassword));
  const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${ token }`); if (init.body) headers.set('content-type', 'application/json');
  const response = await request(target, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const body = await response.clone().json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof body.error === 'string' && body.error ? body.error : `Sulla Files returned ${ response.status }`);
  }
  return response;
}

export async function filesContainerJson<T>(path:string, context:Parameters<typeof filesContainerRequest>[1], init:RequestInit = {}):Promise<T> {
  const response = await filesContainerRequest(path, context, init);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
