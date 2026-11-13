// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * The two token calls ElectronCloudAccountTransport makes on a held session, as small ports so the session tests can
 * stand in for Sulla Cloud without HTTP. Production wraps SullaCloudHttpClient (see ElectronCloudAccountTransport).
 */

/** POSTs the refresh token to Sulla Cloud /auth/refresh. Resolves with ANY HTTP status; rejects only on a network failure. */
export interface CloudRefreshHttp {
  post(refreshToken: string): Promise<{ status: number; body: unknown }>;
}

/** Adapts a fetch-style call to the CloudRefreshHttp port. A 2xx with a body that is not JSON reads as 502. */
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
