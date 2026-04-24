/**
 * MarketplaceClient — thin HTTP layer over the Sulla Cloud marketplace API.
 *
 * The cloud marketplace worker (`sulla-cloud/workers/marketplace`) is not yet
 * deployed. Until it is, write operations (publish/unpublish) return a clear
 * "marketplace API not configured" error documenting the contract. Reads can
 * fall back to the GitHub recipes catalog for `recipe` kind so the agent has
 * something useful even before the cloud worker ships.
 *
 * Configuration:
 * - Base URL: vault `sulla-cloud` integration, property `marketplace_url`.
 *   Falls back to the placeholder default below.
 * - Auth: Bearer token from vault `sulla-cloud` / `api_token`.
 *
 * Contract (the worker should implement):
 *   GET    /v1/marketplace/search?q=&kind=&category=&limit=
 *   GET    /v1/marketplace/artifacts/<kind>/<slug>
 *   GET    /v1/marketplace/artifacts/<kind>/<slug>/download
 *   POST   /v1/marketplace/artifacts/<kind>/<slug>           (publish)
 *   DELETE /v1/marketplace/artifacts/<kind>/<slug>
 *   GET    /v1/marketplace/me/published
 */

import { ArtifactKind, ArtifactSummary } from './types';

const DEFAULT_MARKETPLACE_URL = 'https://marketplace.sulla.dev';
const RECIPES_CATALOG_URL = 'https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/index.yaml';

export interface PublishPayload {
  kind:          ArtifactKind;
  slug:          string;
  version?:      string;
  manifest:      string;            // raw manifest contents
  files:         Record<string, string>; // path → contents (UTF-8 or base64-prefixed)
}

export interface DownloadResult {
  kind:     ArtifactKind;
  slug:     string;
  version?: string;
  manifest: string;
  files:    Record<string, string>;
}

export interface SearchOptions {
  query?:    string;
  kind?:     ArtifactKind;
  category?: string;
  limit?:    number;
}

export class MarketplaceClient {
  private baseUrlPromise: Promise<string> | null = null;
  private tokenPromise:   Promise<string | null> | null = null;

  private async getBaseUrl(): Promise<string> {
    if (!this.baseUrlPromise) {
      this.baseUrlPromise = (async() => {
        try {
          const { getIntegrationService } = await import('../../services/IntegrationService');
          const svc = getIntegrationService();
          const result = await svc.getIntegrationValue('sulla-cloud', 'marketplace_url');
          if (result?.value) return String(result.value).replace(/\/+$/, '');
        } catch {
          // Integration service may not be ready — fall through to default.
        }
        return DEFAULT_MARKETPLACE_URL;
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
        } catch {
          return null;
        }
      })();
    }
    return this.tokenPromise;
  }

  /** Force a fresh credential lookup on the next call. */
  invalidate(): void {
    this.baseUrlPromise = null;
    this.tokenPromise = null;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const token = await this.getToken();

    const url = `${ baseUrl }${ path }`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${ token }`;

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Marketplace API ${ method } ${ path } → HTTP ${ res.status }: ${ text || res.statusText }`);
    }

    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }

  async search(opts: SearchOptions): Promise<ArtifactSummary[]> {
    const params = new URLSearchParams();
    if (opts.query)    params.set('q', opts.query);
    if (opts.kind)     params.set('kind', opts.kind);
    if (opts.category) params.set('category', opts.category);
    if (opts.limit)    params.set('limit', String(opts.limit));

    try {
      const result = await this.request<{ artifacts: ArtifactSummary[] }>('GET', `/v1/marketplace/search?${ params.toString() }`);
      return result.artifacts ?? [];
    } catch (err) {
      // Fallback: recipes have a static GitHub catalog. Use it for `kind:recipe`
      // when the cloud API isn't reachable.
      if (opts.kind === 'recipe' || (!opts.kind && /ECONNREFUSED|HTTP 5\d\d|HTTP 404/.test(String(err)))) {
        return await this.searchRecipesFromGithub(opts);
      }
      throw err;
    }
  }

  async info(kind: ArtifactKind, slug: string): Promise<ArtifactSummary & { metadata: Record<string, unknown> }> {
    return await this.request('GET', `/v1/marketplace/artifacts/${ kind }/${ encodeURIComponent(slug) }`);
  }

  async download(kind: ArtifactKind, slug: string): Promise<DownloadResult> {
    return await this.request('GET', `/v1/marketplace/artifacts/${ kind }/${ encodeURIComponent(slug) }/download`);
  }

  async publish(payload: PublishPayload): Promise<{ url: string; version: string }> {
    return await this.request('POST', `/v1/marketplace/artifacts/${ payload.kind }/${ encodeURIComponent(payload.slug) }`, payload);
  }

  async unpublish(kind: ArtifactKind, slug: string): Promise<void> {
    await this.request('DELETE', `/v1/marketplace/artifacts/${ kind }/${ encodeURIComponent(slug) }`);
  }

  async myPublished(): Promise<ArtifactSummary[]> {
    const result = await this.request<{ artifacts: ArtifactSummary[] }>('GET', '/v1/marketplace/me/published');
    return result.artifacts ?? [];
  }

  // ── GitHub fallback for recipes — lets the agent find recipes even before the cloud API ships ──

  private async searchRecipesFromGithub(opts: SearchOptions): Promise<ArtifactSummary[]> {
    try {
      const res = await fetch(RECIPES_CATALOG_URL);
      if (!res.ok) return [];
      const text = await res.text();
      const yaml = await import('yaml');
      const parsed: any = yaml.parse(text);
      const plugins: any[] = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
      const q = (opts.query || '').toLowerCase();
      const results: ArtifactSummary[] = [];
      for (const p of plugins) {
        const slug: string = String(p?.slug || '');
        const labels: Record<string, string> = (p?.labels || {}) as Record<string, string>;
        const title = labels['org.opencontainers.image.title'] || slug;
        const description = labels['org.opencontainers.image.description'] || '';
        const categories = labels['com.docker.extension.categories'] || '';
        const haystack = `${ slug } ${ title } ${ description } ${ categories }`.toLowerCase();
        if (q && !haystack.includes(q)) continue;
        if (opts.category && !categories.toLowerCase().includes(opts.category.toLowerCase())) continue;
        results.push({
          kind:        'recipe',
          slug,
          name:        title,
          version:     String(p?.version || ''),
          description,
          tags:        categories ? categories.split(',').map(s => s.trim()) : [],
          publisher:   labels['com.docker.extension.publisher-url'] || '',
          updated_at:  labels['org.opencontainers.image.created'] || '',
        });
        if (opts.limit && results.length >= opts.limit) break;
      }
      return results;
    } catch {
      return [];
    }
  }
}

let singleton: MarketplaceClient | null = null;

export function getMarketplaceClient(): MarketplaceClient {
  if (!singleton) singleton = new MarketplaceClient();
  return singleton;
}
