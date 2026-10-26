// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

export class UpstreamError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`Upstream request failed with ${status}`);
  }
}

export class UpstreamClient {
  constructor(private readonly baseUrl: URL) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Upstream path must be absolute and relative to the configured service');
    const response = await fetch(new URL(path, this.baseUrl), { ...init, redirect: 'error' });
    const type = response.headers.get('content-type') ?? '';
    const body: unknown = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new UpstreamError(response.status, body);
    return body as T;
  }
}
