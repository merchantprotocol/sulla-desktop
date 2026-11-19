// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The slice of FilesCloudBroker the share flows use (a fake in specs). */
export interface ShareCloudBroker {
  execute(path:string, method?:string, body?:unknown, contentType?:string):Promise<{ status:number; body:unknown }>;
}

export interface ExpectedSharePolicy {
  accessMode:string;
  passwordProtected:boolean;
  expiresAt:string | null;
  keepAvailable:boolean;
  keepUntil:string | null;
  displaySharerName:boolean;
  passwordChanged?:boolean;
}

/** Sulla Cloud's /shares API through the vault broker, plus the checks on what Cloud confirms. */
export class ShareCloudGateway {
  constructor(private readonly broker?:ShareCloudBroker) {}

  get available():boolean { return Boolean(this.broker) }

  async request(path: string, init: RequestInit = {}, acceptedStatuses:number[] = []):Promise<any> {
    const body = init.body instanceof Uint8Array ? init.body : init.body;
    if (!this.broker) throw Object.assign(new Error('Sulla Cloud broker is unavailable'), { status: 503 });
    const method = (init.method ?? 'GET').toUpperCase();
    const result = await this.broker.execute(path, method, body, new Headers(init.headers).get('Content-Type') ?? undefined);
    if (![200, 201, 202, 204, ...acceptedStatuses].includes(result.status)) {
      const missingCloudCopy = result.status === 404 && method === 'PUT' && /^\/shares\/[A-Za-z0-9._~-]{1,200}\/content$/.test(path);
      const safePath = path.replace(/^\/shares\/[^/]+/, '/shares/:id');
      throw Object.assign(new Error(`Sulla Cloud returned ${ result.status } for ${ method } ${ safePath }`), {
        status: 502,
        ...(missingCloudCopy ? { code: 'SULLA_CLOUD_CONTENT_NOT_FOUND' } : {}),
      });
    }
    return result.body ?? {};
  }

  /** True when Cloud confirmed the link is gone (404 counts); false on any failure. */
  async deleteRemote(id:string):Promise<boolean> {
    try { await this.request(`/shares/${ encodeURIComponent(id) }`, { method: 'DELETE' }, [404]); return true } catch { return false }
  }

  assertPolicy(cloud:any, expected:ExpectedSharePolicy):void {
    const time = (value:unknown) => typeof value === 'string' && value ? new Date(value).toISOString() : null;
    const mismatches:string[] = [];

    if (!cloud || typeof cloud !== 'object') throw Object.assign(new Error('Sulla Cloud returned no share policy'), { status: 502 });
    if (cloud.accessMode !== expected.accessMode) mismatches.push('accessMode');
    if (Boolean(cloud.passwordProtected) !== expected.passwordProtected) mismatches.push('passwordProtected');
    if (expected.passwordChanged && expected.passwordProtected && cloud.passwordUpdated !== true) mismatches.push('passwordUpdated');
    if (time(cloud.expiresAt) !== time(expected.expiresAt)) mismatches.push('expiresAt');
    if (cloud.keepAvailable !== expected.keepAvailable) mismatches.push('keepAvailable');
    if (!Object.hasOwn(cloud, 'keepUntil') || time(cloud.keepUntil) !== time(expected.keepUntil)) mismatches.push('keepUntil');
    if (cloud.displaySharerName !== expected.displaySharerName) mismatches.push('displaySharerName');
    if (mismatches.length) throw Object.assign(new Error(`Sulla Cloud did not confirm share policy fields: ${ mismatches.join(', ') }`), { status: 502 });
  }

  /** The Cloud-owned fields of a remote share, under their local column names. */
  overlay(value:unknown):Record<string, unknown> {
    if (!value || typeof value !== 'object') return {};
    const remote = value as Record<string, unknown>; const safe:Record<string, unknown> = {};
    const copy = (target:string, ...sources:string[]) => {
      const source = sources.find(key => remote[key] !== undefined);
      if (source) safe[target] = remote[source];
    };

    copy('public_url', 'url', 'public_url', 'publicUrl');
    copy('view_count', 'viewCount', 'view_count', 'views');
    copy('last_viewed_at', 'lastViewedAt', 'last_viewed_at');
    copy('expires_at', 'expiresAt', 'expires_at');
    copy('keep_available', 'keepAvailable', 'keep_available');
    copy('keep_until', 'keepUntil', 'keep_until');
    copy('display_sharer_name', 'displaySharerName', 'display_sharer_name');
    copy('served_from', 'servedFrom', 'served_from');
    copy('access_mode', 'accessMode', 'access_mode');
    copy('revoked_at', 'revokedAt', 'revoked_at');

    return safe;
  }
}
