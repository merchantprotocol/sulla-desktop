// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  CloudAccountTransport, CloudEmailCodeStartRequestDto, CloudEmailCodeStartResponseDto, CloudEmailCodeVerifyRequestDto,
  CloudEmailLoginRequestDto, CloudPreloginRequestDto, CloudPreloginResponseDto, CloudRefreshRequestDto,
  CloudRegisterRequestDto, CloudSessionResponseDto, CloudTokenPairDto, CloudUpgradeRequestDto,
} from '@sulla/domain';

import { parseSullaCloudRefresh, SULLA_CLOUD_LOGOUT_URL, SULLA_CLOUD_REFRESH_URL } from '../sullaCloudRelay.js';

/** POSTs JSON to the fixed Sulla Cloud origin (pinned DNS, HTTPS only). Resolves with ANY HTTP status; rejects only on network failure. */
export interface SullaCloudHttpPort {
  postJson(url: string, body: { refreshToken: string }): Promise<{ status: number; body: unknown }>;
}

/** The server answered with a non-2xx status. The message never carries a token. */
export class SullaCloudHttpError extends Error {
  constructor(readonly status: number, endpoint: string) {
    super(`Sulla Cloud ${ endpoint } returned HTTP ${ status }`);
    this.name = 'SullaCloudHttpError';
  }
}

/** No HTTP status at all: DNS, TLS, timeout, lock-during-request. Classified as transient (tokens stay, revoke is queued). */
export class SullaCloudNetworkError extends Error {
  constructor(endpoint: string) {
    super(`Sulla Cloud ${ endpoint } is unreachable`);
    this.name = 'SullaCloudNetworkError';
  }
}

/**
 * The vault only needs the two token endpoints. Wire formats are unchanged: POST /auth/refresh {refreshToken}
 * and POST /auth/logout {refreshToken}. Everything else on the port is Electron/renderer business and fails loudly.
 */
export class VaultCloudAccountTransport implements CloudAccountTransport {
  constructor(private readonly http: SullaCloudHttpPort) {}

  async refresh(request: CloudRefreshRequestDto): Promise<CloudTokenPairDto> {
    const response = await this.post(SULLA_CLOUD_REFRESH_URL, '/auth/refresh', request.refreshToken);
    let parsed: ReturnType<typeof parseSullaCloudRefresh>;
    try {
      parsed = parseSullaCloudRefresh(response.body);
    } catch {
      // A 2xx with an unreadable body is the server's fault, not a revocation: surface it as a 502 (transient).
      throw new SullaCloudHttpError(502, '/auth/refresh');
    }
    // Same as before: a refresh response without a new refresh token keeps the current one.
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken ?? request.refreshToken };
  }

  async logout(request: CloudRefreshRequestDto): Promise<void> {
    if (!request.refreshToken) throw new Error('logout needs a refresh token');
    await this.post(SULLA_CLOUD_LOGOUT_URL, '/auth/logout', request.refreshToken);
  }

  private async post(url: string, endpoint: string, refreshToken: string): Promise<{ status: number; body: unknown }> {
    let response: { status: number; body: unknown };
    try {
      response = await this.http.postJson(url, { refreshToken });
    } catch {
      // Whatever the pinned client threw (it can carry its own HTTP-ish status, e.g. a 403 destination policy) is NOT the server's verdict.
      throw new SullaCloudNetworkError(endpoint);
    }
    if (response.status < 200 || response.status >= 300) throw new SullaCloudHttpError(response.status, endpoint);
    return response;
  }

  prelogin(_request: CloudPreloginRequestDto): Promise<CloudPreloginResponseDto> { return this.unsupported(); }
  register(_request: CloudRegisterRequestDto): Promise<CloudSessionResponseDto> { return this.unsupported(); }
  emailLogin(_request: CloudEmailLoginRequestDto): Promise<CloudSessionResponseDto> { return this.unsupported(); }
  upgrade(_request: CloudUpgradeRequestDto): Promise<CloudSessionResponseDto> { return this.unsupported(); }
  startEmailCode(_request: CloudEmailCodeStartRequestDto): Promise<CloudEmailCodeStartResponseDto> { return this.unsupported(); }
  verifyEmailCode(_request: CloudEmailCodeVerifyRequestDto): Promise<CloudSessionResponseDto> { return this.unsupported(); }

  private unsupported(): never {
    throw new Error('The vault only performs token refresh and logout');
  }
}
