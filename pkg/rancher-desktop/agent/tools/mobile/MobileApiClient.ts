/**
 * MobileApiClient — thin HTTP layer for the Sulla Mobile backend on
 * Cloudflare Workers. The desktop agent can query the same endpoints the
 * phone hits — calls, leads, messages — so "show me my last call from
 * mobile" works without picking up the phone.
 *
 * Resolution:
 * - Base URL: vault `sulla-cloud` → `mobile_api_url`, else the default below.
 * - Auth: vault `sulla-cloud` → `api_token` (JWT — same one mobile uses).
 */

const DEFAULT_API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';

export class MobileApiClient {
  private baseUrlPromise: Promise<string> | null = null;
  private tokenPromise: Promise<string | null> | null = null;

  private async getBaseUrl(): Promise<string> {
    if (!this.baseUrlPromise) {
      this.baseUrlPromise = (async() => {
        try {
          const { getIntegrationService } = await import('../../services/IntegrationService');
          const svc = getIntegrationService();
          const result = await svc.getIntegrationValue('sulla-cloud', 'mobile_api_url');
          if (result?.value) return String(result.value).replace(/\/+$/, '');
        } catch { /* fall through */ }
        return DEFAULT_API_BASE;
      })();
    }
    return this.baseUrlPromise;
  }

  private async getToken(): Promise<string | null> {
    if (!this.tokenPromise) {
      this.tokenPromise = (async() => {
        try {
          const { getIntegrationService } = await import('../../services/IntegrationService');
          const svc = getIntegrationService();
          const result = await svc.getIntegrationValue('sulla-cloud', 'api_token');
          return result?.value ? String(result.value) : null;
        } catch { return null; }
      })();
    }
    return this.tokenPromise;
  }

  invalidate(): void {
    this.baseUrlPromise = null;
    this.tokenPromise = null;
  }

  async request<T>(method: string, pathSegment: string, body?: unknown): Promise<T> {
    const base = await this.getBaseUrl();
    const token = await this.getToken();
    if (!token) {
      throw new Error('No Sulla Cloud token in vault (sulla-cloud/api_token). Sign in on your phone and sync the token.');
    }

    const headers: Record<string, string> = {
      Accept:         'application/json',
      Authorization:  `Bearer ${ token }`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${ base }${ pathSegment }`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mobile API ${ method } ${ pathSegment } → HTTP ${ res.status }: ${ text || res.statusText }`);
    }
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }
}

let singleton: MobileApiClient | null = null;

export function getMobileApiClient(): MobileApiClient {
  if (!singleton) singleton = new MobileApiClient();
  return singleton;
}
