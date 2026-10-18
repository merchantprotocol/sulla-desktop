import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import { issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';

import type { ToolExecutionContext } from '../tools/executionContext';

const DEFAULT_FILES_API = 'http://127.0.0.1:30124';
const TRUSTED_FILES_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', 'sulla_files']);

export type FilesCallerContext = Partial<Pick<ToolExecutionContext, 'sub' | 'org_id' | 'group_ids' | 'agent_id' | 'job_id' | 'thread_id' | 'device_id'>>;

function filesApi():URL {
  const url = new URL(process.env.SULLA_FILES_API_URL || DEFAULT_FILES_API);
  if (url.protocol !== 'http:' || !TRUSTED_FILES_HOSTS.has(url.hostname) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Sulla Files agent API must use the trusted local service origin');
  }
  return url;
}

async function localPrincipal(api:URL, servicePassword:string):Promise<string> {
  const response = await fetch(new URL('/v1/local/identity', api), {
    headers:  { 'x-sulla-files-token': servicePassword },
    redirect: 'error',
    signal:   AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('Sulla Files could not resolve the local principal');
  const body = await response.json() as { principalId?:unknown };
  if (typeof body.principalId !== 'string' || !body.principalId) throw new Error('Sulla Files returned an invalid local principal');
  return body.principalId;
}

export async function filesContainerRequest(path:string, context:FilesCallerContext, init:RequestInit = {}):Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Files endpoint must be service-relative');
  const api = filesApi();
  const servicePassword = await SullaSettingsModel.getServicePassword();
  // The Files service owns user identity. Never trust a caller-supplied subject
  // for local ACL decisions, including tool contexts restored from old threads.
  const sub = await localPrincipal(api, servicePassword);
  const token = issueCapabilityToken({ ...context, sub, scopes: ['files/*'], expiresInSeconds: 300 }, sullaFilesCapabilityKey(servicePassword));
  const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${ token }`); if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(new URL(path, api), { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const body = await response.clone().json().catch(() => ({})) as { error?:unknown };
    throw new Error(typeof body.error === 'string' && body.error ? body.error : `Sulla Files returned ${ response.status }`);
  }
  return response;
}

export async function filesContainerJson<T>(path:string, context:Parameters<typeof filesContainerRequest>[1], init:RequestInit = {}):Promise<T> {
  const response = await filesContainerRequest(path, context, init);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
