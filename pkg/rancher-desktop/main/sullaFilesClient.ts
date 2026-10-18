import { getSullaFilesWatcher } from './sullaFilesWatcher';

import type { SullaFilesCapabilityContext } from './sullaFilesWatcher';

export type FilesRequestAuthority =
  | { kind: 'desktop' }
  | { kind: 'agent'; agentId: string; jobId?: string; threadId?: string };

export interface FilesRequestOptions {
  authority?: FilesRequestAuthority;
  server?:    boolean;
}

export class FilesApiError extends Error {
  constructor(message:string, readonly status:number) { super(message) }
}

function capability(authority:FilesRequestAuthority):SullaFilesCapabilityContext {
  if (authority.kind === 'desktop') return {};
  if (!authority.agentId.trim()) throw new Error('Files agent authority requires an agent id');

  return { agentId: authority.agentId, jobId: authority.jobId, threadId: authority.threadId };
}

async function errorMessage(response:Response):Promise<string> {
  const body = await response.clone().json().catch(() => ({})) as { error?:unknown; message?:unknown };
  if (typeof body.error === 'string' && body.error) return body.error;
  if (typeof body.message === 'string' && body.message) return body.message;

  return `Files request failed (${ response.status })`;
}

/**
 * Main-process adapter for the Files service. Authentication, origin pinning,
 * unlock retries, and principal resolution stay in SullaFilesWatcher; callers
 * only describe which trusted Desktop or agent authority is making a request.
 */
export class SullaFilesClient {
  async request(endpoint:string, init:RequestInit = {}, options:FilesRequestOptions = {}):Promise<Response> {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//')) throw new Error('Files endpoint must be service-relative');
    const authority = options.authority ?? { kind: 'desktop' };
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

    return getSullaFilesWatcher().requestFiles(endpoint, { ...init, headers }, options.server === true, capability(authority));
  }

  async json<T>(endpoint:string, init:RequestInit = {}, options:FilesRequestOptions = {}):Promise<T> {
    const response = await this.request(endpoint, init, options);
    if (!response.ok) throw new FilesApiError(await errorMessage(response), response.status);

    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }

  async stream(endpoint:string, init:RequestInit = {}, signal?:AbortSignal):Promise<Response> {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//')) throw new Error('Files endpoint must be service-relative');
    return getSullaFilesWatcher().requestFilesStream(endpoint, init, signal);
  }
}

let instance:SullaFilesClient | undefined;
export function getSullaFilesClient():SullaFilesClient {
  instance ??= new SullaFilesClient();
  return instance;
}
