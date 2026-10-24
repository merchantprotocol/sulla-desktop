// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { Request } from 'express';

import { UpstreamClient } from './upstream.js';

export interface AccountsSession {
  authenticated: true;
  identity: { issuer: string; subject: string };
  organizations: Array<{ id: string; name: string; slug: string; roles: string[]; groups: string[] }>;
  expiresAt: string;
}

export class AccountsClient extends UpstreamClient {
  session(request: Request): Promise<AccountsSession> {
    return this.request('/v1/web/session', { headers: forwardedWebHeaders(request) });
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
