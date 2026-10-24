// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { Request } from 'express';

import { UpstreamClient } from './upstream.js';

export interface AccountsSession {
  authenticated: true;
  identity: { issuer: string; subject: string; roles?: string[]; realmRoles?: string[] };
  organizations: Array<{ id: string; name: string; slug: string; roles: string[]; groups: string[] }>;
  expiresAt: string;
}

export class AccountsClient extends UpstreamClient {
  constructor(baseUrl: URL, private readonly adminSecret?: string) { super(baseUrl); }
  session(request: Request): Promise<AccountsSession> {
    return this.request('/v1/web/session', { headers: forwardedWebHeaders(request) });
  }

  admin<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.adminSecret) throw new Error('Accounts admin secret is not configured');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.adminSecret}`);
    if (init.body) headers.set('content-type', 'application/json');
    return this.request(`/v1/admin${path}`, { ...init, headers });
  }
}

export function forwardedWebHeaders(request: Request): Headers {
  const headers = new Headers();
  const cookie = request.header('cookie');
  const csrf = request.header('x-sulla-csrf');
  if (cookie) headers.set('cookie', cookie);
  if (csrf) headers.set('x-sulla-csrf', csrf);
  return headers;
}
