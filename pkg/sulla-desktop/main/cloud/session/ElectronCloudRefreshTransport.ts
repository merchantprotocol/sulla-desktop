// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  CloudAccountTransport, CloudEmailCodeStartRequestDto, CloudEmailCodeStartResponseDto, CloudEmailCodeVerifyRequestDto,
  CloudEmailLoginRequestDto, CloudPreloginRequestDto, CloudPreloginResponseDto, CloudRefreshRequestDto,
  CloudRegisterRequestDto, CloudSessionResponseDto, CloudTokenPairDto, CloudUpgradeRequestDto,
} from '@sulla/domain';

/** POSTs the refresh token to Sulla Cloud /auth/refresh. Resolves with ANY HTTP status; rejects only on a network failure. */
export interface CloudRefreshHttp {
  post(refreshToken: string): Promise<{ status: number; body: unknown }>;
}

/** The server answered with a non-2xx status. The message never carries a token. */
export class CloudRefreshHttpError extends Error {
  constructor(readonly status: number) {
    super(`Sulla Cloud /auth/refresh returned HTTP ${ status }`);
    this.name = 'CloudRefreshHttpError';
  }
}

/** No HTTP status at all (DNS, TLS, timeout). Classified as transient: the tokens stay. */
export class CloudRefreshNetworkError extends Error {
  constructor() {
    super('Sulla Cloud /auth/refresh is unreachable');
    this.name = 'CloudRefreshNetworkError';
  }
}

/** Adapts a fetch-style call to the CloudRefreshHttp port. */
export class FetchCloudRefreshHttp implements CloudRefreshHttp {
  constructor(private readonly send: (refreshToken: string) => Promise<Response>) {}

  async post(refreshToken: string): Promise<{ status: number; body: unknown }> {
    const response = await this.send(refreshToken);
    if (!response.ok) return { status: response.status, body: null };
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      return { status: 502, body: null };
    }
  }
}

/** POSTs the refresh token to Sulla Cloud /auth/logout. Resolves with the HTTP status only (a successful logout may have no body); rejects only on a network failure. */
export interface CloudLogoutHttp {
  post(refreshToken: string): Promise<{ status: number }>;
}

/** /auth/logout answered with a non-2xx status. The message never carries a token. */
export class CloudLogoutHttpError extends Error {
  constructor(readonly status: number) {
    super(`Sulla Cloud /auth/logout returned HTTP ${ status }`);
    this.name = 'CloudLogoutHttpError';
  }
}

/** /auth/logout could not be reached (DNS, TLS, timeout). No status, so it is classified as transient. */
export class CloudLogoutNetworkError extends Error {
  constructor() {
    super('Sulla Cloud /auth/logout is unreachable');
    this.name = 'CloudLogoutNetworkError';
  }
}

/**
 * Status-only adapter for /auth/logout. Unlike FetchCloudRefreshHttp it never parses the body: an empty or non-JSON
 * 2xx is still a successful revoke, not a 502. The body is read and discarded so the connection is released.
 */
export class FetchCloudLogoutHttp implements CloudLogoutHttp {
  constructor(private readonly send: (refreshToken: string) => Promise<Response>) {}

  async post(refreshToken: string): Promise<{ status: number }> {
    const response = await this.send(refreshToken);
    await response.text().catch(() => '');
    return { status: response.status };
  }
}

/**
 * Desktop only needs the token refresh on this path. The wire format is unchanged: POST /auth/refresh {refreshToken}.
 * A response without a new refresh token keeps the current one. The other account calls stay in the Electron sign-in flow.
 * With a logout port it also revokes the session (POST /auth/logout {refreshToken}) for the domain SignOutService.
 */
export class ElectronCloudRefreshTransport implements CloudAccountTransport {
  constructor(private readonly http: CloudRefreshHttp, private readonly logoutHttp: CloudLogoutHttp | null = null) {}

  async refresh(request: CloudRefreshRequestDto): Promise<CloudTokenPairDto> {
    let response: { status: number; body: unknown };
    try {
      response = await this.http.post(request.refreshToken);
    } catch {
      // Whatever the client threw is not the server's verdict, and may carry a status of its own.
      throw new CloudRefreshNetworkError();
    }
    if (response.status < 200 || response.status >= 300) throw new CloudRefreshHttpError(response.status);
    const body = (response.body ?? {}) as { accessToken?: unknown; refreshToken?: unknown };
    // A 2xx with an unreadable body is the server's fault, not a revocation.
    if (typeof body.accessToken !== 'string' || !body.accessToken) throw new CloudRefreshHttpError(502);
    const next = typeof body.refreshToken === 'string' && body.refreshToken ? body.refreshToken : request.refreshToken;
    return { accessToken: body.accessToken, refreshToken: next };
  }

  /** Resolves on any 2xx, body or not. Rejects with the HTTP status (401/403 = already revoked, 5xx = transient) or with no status on a network failure. */
  async logout(request: CloudRefreshRequestDto): Promise<void> {
    const http = this.logoutHttp;
    if (!http) return this.unsupported();
    // A blank token is a silent no-op on the server, so it would report a revoke that never happened.
    if (!request.refreshToken) throw new Error('Refusing to log out without a refresh token');
    let response: { status: number };
    try {
      response = await http.post(request.refreshToken);
    } catch {
      throw new CloudLogoutNetworkError();
    }
    if (response.status < 200 || response.status >= 300) throw new CloudLogoutHttpError(response.status);
  }

  prelogin(_request: CloudPreloginRequestDto): Promise<CloudPreloginResponseDto> { return this.unsupported(); }
  register(_request: CloudRegisterRequestDto): Promise<CloudSessionResponseDto> { return this.unsupported(); }
  emailLogin(_request: CloudEmailLoginRequestDto): Promise<CloudSessionResponseDto> { return this.unsupported(); }
  upgrade(_request: CloudUpgradeRequestDto): Promise<CloudSessionResponseDto> { return this.unsupported(); }
  startEmailCode(_request: CloudEmailCodeStartRequestDto): Promise<CloudEmailCodeStartResponseDto> { return this.unsupported(); }
  verifyEmailCode(_request: CloudEmailCodeVerifyRequestDto): Promise<CloudSessionResponseDto> { return this.unsupported(); }

  private unsupported(): never {
    throw new Error('This Desktop path only refreshes tokens');
  }
}
