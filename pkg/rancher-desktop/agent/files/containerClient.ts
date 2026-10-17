import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import { issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';

import type { ToolExecutionContext } from '../tools/executionContext';

const FILES_API = process.env.SULLA_FILES_API_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:30124';

export async function filesContainerRequest(path:string, context:Pick<ToolExecutionContext, 'sub' | 'org_id' | 'group_ids' | 'agent_id' | 'job_id' | 'thread_id' | 'device_id'>, init:RequestInit = {}):Promise<Response> {
  const signingKey = sullaFilesCapabilityKey(await SullaSettingsModel.getServicePassword());
  const token = issueCapabilityToken({ ...context, scopes: ['files/*'], expiresInSeconds: 300 }, signingKey);
  const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${ token }`); if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${ FILES_API }${ path }`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Sulla Files returned ${ response.status }: ${ (await response.text()).slice(0, 200) }`);
  return response;
}

export async function filesContainerJson<T>(path:string, context:Parameters<typeof filesContainerRequest>[1], init:RequestInit = {}):Promise<T> {
  const response = await filesContainerRequest(path, context, init);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
