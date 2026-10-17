import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { getSullaFilesWatcher } from '@pkg/main/sullaFilesWatcher';

export type ShareMode = 'view' | 'download';

export interface ShareLink {
  id:             string;
  url:            string;
  name:           string;
  mode:           ShareMode;
  password:       boolean;
  expiresAt?:     string;
  viewCount:      number;
  keepAvailable:  boolean;
}

export interface CreateShareInput {
  fileId:         string;
  mode:           ShareMode;
  password?:      string;
  expiresAt?:     string;
  keepAvailable:  boolean;
  capture?:       boolean;
  captureMetadata?: Record<string, unknown>;
}

export interface LinkService {
  create(input:CreateShareInput):Promise<ShareLink>;
  list():Promise<ShareLink[]>;
  revoke(id:string):Promise<void>;
  setKeepAvailable(id:string, enabled:boolean):Promise<ShareLink>;
}

export class SharingUnavailableError extends Error {}

function normalize(value:any):ShareLink {
  return {
    id:            String(value.id ?? value.token ?? ''),
    url:           String(value.url ?? value.public_url ?? value.publicUrl ?? ''),
    name:          String(value.name ?? value.display_name ?? value.displayName ?? 'Shared file'),
    mode:          value.permission === 'download' || value.access_mode === 'download' || value.accessMode === 'download' ? 'download' : 'view',
    password:      Boolean(value.password ?? value.password_protected ?? value.passwordProtected),
    expiresAt:     value.expiresAt ?? value.expires_at ?? undefined,
    viewCount:     Number(value.viewCount ?? value.view_count ?? 0),
    keepAvailable: Boolean(value.keepAvailable ?? value.keep_available),
  };
}

async function requestWithContractFallback(paths:string[], init:RequestInit):Promise<Response> {
  let last:Response | undefined;
  for (const path of paths) {
    let response:Response;

    try { response = await getSullaFilesWatcher().requestFiles(path, init) } catch (error) {
      throw new SharingUnavailableError(`Sharing service is offline: ${ error instanceof Error ? error.message : String(error) }`);
    }
    if (![404, 405].includes(response.status)) return response;
    last = response;
  }
  throw new SharingUnavailableError(`Sharing API is not installed (${ last?.status ?? 'offline' })`);
}

/** Thin adapter over the Phase 4 public-link contract; it never owns links. */
export class SullaFilesLinkService implements LinkService {
  async create(input:CreateShareInput):Promise<ShareLink> {
    const cloudToken = await getCurrentAccessToken();
    if (!cloudToken) throw new SharingUnavailableError('Sign in to Sulla Cloud before sharing');
    const deviceId = await getDesktopDeviceId();
    const body = JSON.stringify({
      fileId: input.fileId, permission: input.mode, accessMode: input.mode, password: input.password,
      expiresAt: input.expiresAt, keepAvailable: input.keepAvailable,
      assetKind: input.capture ? 'capture' : 'file', captureMetadata: input.captureMetadata,
      deviceId,
    });
    const response = await requestWithContractFallback(['/v1/links', '/v1/shares'], {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-sulla-cloud-token': cloudToken }, body,
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error ?? `Sharing failed (${ response.status })`);
    const share = normalize(await response.json());
    if (!share.url) throw new Error('Sharing service returned no public URL');

    return share;
  }

  async list():Promise<ShareLink[]> {
    const cloudToken = await getCurrentAccessToken(); const headers:Record<string, string> = {};
    if (cloudToken) headers['x-sulla-cloud-token'] = cloudToken;
    const response = await requestWithContractFallback(['/v1/links?createdBy=me', '/v1/shares'], { headers });
    if (!response.ok) throw new Error(`Recent shares failed (${ response.status })`);
    const body = await response.json(); const values = Array.isArray(body) ? body : body.links ?? body.shares ?? [];

    return values.map(normalize);
  }

  async revoke(id:string):Promise<void> {
    const cloudToken = await getCurrentAccessToken();
    if (!cloudToken) throw new SharingUnavailableError('Sign in to Sulla Cloud before revoking a public link');
    const response = await requestWithContractFallback([`/v1/links/${ encodeURIComponent(id) }`], {
      method:  'DELETE',
      headers: { 'x-sulla-cloud-token': cloudToken },
    });
    if (!response.ok) throw new Error(`Revoke share failed (${ response.status })`);
  }

  async setKeepAvailable(id:string, enabled:boolean):Promise<ShareLink> {
    const cloudToken = await getCurrentAccessToken();
    if (!cloudToken) throw new SharingUnavailableError('Sign in to Sulla Cloud before changing link availability');
    const response = await requestWithContractFallback([`/v1/links/${ encodeURIComponent(id) }`], {
      method:  'PATCH',
      headers: { 'content-type': 'application/json', 'x-sulla-cloud-token': cloudToken },
      body:    JSON.stringify({ keepAvailable: enabled }),
    });
    if (!response.ok) throw new Error(`Update share failed (${ response.status })`);

    return normalize(await response.json());
  }
}

let links:LinkService | undefined;
export function getSullaFilesLinkService():LinkService { links ??= new SullaFilesLinkService(); return links }
