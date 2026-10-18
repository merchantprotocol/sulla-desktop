import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import { issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';

import type { ToolExecutionContext } from '../tools/executionContext';

const FILES_API = process.env.SULLA_FILES_API_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:30124';
const FILES_ORIGIN = new URL(FILES_API);
const LOCAL_FILES_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'sulla_files']);

export async function filesContainerRequest(path:string, context:Pick<ToolExecutionContext, 'sub' | 'org_id' | 'group_ids' | 'agent_id' | 'job_id' | 'thread_id' | 'device_id'>, init:RequestInit = {}):Promise<Response> {
  const servicePassword = await SullaSettingsModel.getServicePassword();
  let principalId = context.sub;
  if (FILES_ORIGIN.protocol === 'http:' && LOCAL_FILES_HOSTS.has(FILES_ORIGIN.hostname)) {
    const identity = await fetch(`${ FILES_API }/v1/local/identity`, {
      headers:  { 'x-sulla-files-token': servicePassword },
      redirect: 'error',
      signal:   AbortSignal.timeout(30_000),
    });
    if (!identity.ok) throw new Error(`Sulla Files identity is unavailable (${ identity.status })`);
    const body = await identity.json() as { principalId?:unknown };
    if (typeof body.principalId !== 'string' || !body.principalId) throw new Error('Sulla Files returned an invalid identity');
    principalId = body.principalId;
  }
  const signingKey = sullaFilesCapabilityKey(servicePassword);
  const token = issueCapabilityToken({ ...context, sub: principalId, scopes: ['files/*'], expiresInSeconds: 300 }, signingKey);
  const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${ token }`); if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${ FILES_API }${ path }`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Sulla Files returned ${ response.status }: ${ (await response.text()).slice(0, 200) }`);
  return response;
}

export async function filesContainerJson<T>(path:string, context:Parameters<typeof filesContainerRequest>[1], init:RequestInit = {}):Promise<T> {
  const response = await filesContainerRequest(path, context, init);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
