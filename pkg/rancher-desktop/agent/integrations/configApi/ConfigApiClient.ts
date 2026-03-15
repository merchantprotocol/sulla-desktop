import { getIntegrationService } from '../../services/IntegrationService';
import type {
  EndpointConfig,
  LoadedIntegration,
  PaginationConfig,
} from './types';

const LOG = '[ConfigApiClient]';

export interface CallOptions {
  pageToken?: string;
  /** Return raw JSON instead of extracting items */
  raw?:       boolean;
  /** Override auth token for this request */
  token?:     string;
  /** Override API key for this request */
  apiKey?:    string;
  /** Request body for POST/PUT/PATCH */
  body?:      unknown;
  /** Extra headers merged into the request */
  headers?:   Record<string, string>;
  /** AbortSignal for cancellation */
  signal?:    AbortSignal;
  /** Account ID for credential lookup (overrides active account) */
  accountId?: string;
}

export interface PaginatedResult<T = any> {
  items:          T[];
  nextPageToken?: string;
  prevPageToken?: string;
  raw:            any;
}

/**
 * Converts YAML-defined integration configs into live API calls.
 *
 * Credentials are resolved in order:
 *   1. Explicit `options.token` / `options.apiKey`
 *   2. IntegrationService DB values (slug = folder name, e.g. "youtube")
 *   3. YAML `${ENV_VAR}` references -> process.env
 *
 * Usage:
 *   const client = new ConfigApiClient(loadedIntegration, 'youtube');
 *   const result = await client.call('search', { q: 'funny cats', maxResults: 10 });
 */
export class ConfigApiClient {
  private integration:    LoadedIntegration;
  private slug:           string;
  private baseUrl:        string;
  private defaultHeaders: Record<string, string> = {};

  constructor(integration: LoadedIntegration, slug: string) {
    this.integration = integration;
    this.slug = slug;
    this.baseUrl = integration.auth.api.base_url.replace(/\/+$/, '');
  }

  /** Integration slug (folder name, used as IntegrationService ID) */
  get integrationSlug(): string {
    return this.slug;
  }

  /** API name from the auth config (e.g. "youtube-data-v3") */
  get name(): string {
    return this.integration.auth.api.name;
  }

  /** All discovered endpoint names */
  get endpointNames(): string[] {
    return [...this.integration.endpoints.keys()];
  }

  /** Get the raw endpoint config */
  getEndpoint(name: string): EndpointConfig | undefined {
    return this.integration.endpoints.get(name);
  }

  /** Get the full loaded integration config */
  getIntegration(): LoadedIntegration {
    return this.integration;
  }

  /**
   * Execute an API call against a named endpoint.
   */
  async call<T = any>(
    endpointName: string,
    params: Record<string, any> = {},
    options: CallOptions = {},
  ): Promise<PaginatedResult<T> | T> {
    const epConfig = this.integration.endpoints.get(endpointName);
    if (!epConfig) {
      const available = this.endpointNames.join(', ');
      throw new Error(`${ LOG } Endpoint "${ endpointName }" not found. Available: ${ available }`);
    }

    const ep = epConfig.endpoint;
    const url = await this.buildUrl(epConfig, params, options, options.accountId);
    const headers = await this.buildHeaders(epConfig, options, options.accountId);

    const fetchInit: RequestInit = {
      method: ep.method,
      headers,
      signal: options.signal,
    };

    // Body for POST/PUT/PATCH
    if (options.body && ['POST', 'PUT', 'PATCH'].includes(ep.method)) {
      fetchInit.body = JSON.stringify(options.body);
      (fetchInit.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }

    console.log(`${ LOG } ${ ep.method } ${ url.toString() }`);

    const res = await fetch(url.toString(), fetchInit);

    if (!res.ok) {
      const errBody = await res.text().catch(() => 'Unknown error');
      throw new Error(`${ LOG } ${ ep.method } ${ ep.path } returned ${ res.status }: ${ errBody }`);
    }

    const data = await res.json();

    if (options.raw) {
      return data as T;
    }

    if (epConfig.pagination) {
      return this.extractPaginated<T>(data, epConfig.pagination, epConfig.response);
    }

    return data as T;
  }

  /**
   * Async generator that auto-paginates through all pages.
   */
  async * paginate<T = any>(
    endpointName: string,
    params: Record<string, any> = {},
    options: Omit<CallOptions, 'pageToken' | 'raw'> = {},
  ): AsyncGenerator<T[], void, undefined> {
    let pageToken: string | undefined;

    do {
      const result = await this.call<T>(endpointName, params, { ...options, pageToken });

      if (!isPaginatedResult<T>(result)) {
        yield Array.isArray(result) ? result : [result];
        return;
      }

      if (result.items.length > 0) {
        yield result.items;
      }

      pageToken = result.nextPageToken;
    } while (pageToken);
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Resolve a credential value. Checks:
   *  1. IntegrationService DB (slug + property)
   *  2. YAML ${ENV_VAR} -> process.env
   *  3. Raw string value
   */
  private async resolveCredential(property: string, yamlValue?: string, accountId?: string): Promise<string> {
    // Try IntegrationService first (DB-stored credentials)
    try {
      const svc = getIntegrationService();
      const dbValue = await svc.getIntegrationValue(this.slug, property, accountId);
      if (dbValue?.value) {
        return dbValue.value;
      }
    } catch {
      // IntegrationService may not be initialized yet
    }

    // Fall back to YAML value (may be ${ENV_VAR} reference)
    if (yamlValue) {
      return this.resolveEnvValue(yamlValue);
    }

    return '';
  }

  /**
   * Get an OAuth access token from IntegrationService.
   */
  private async getOAuthToken(accountId?: string): Promise<string> {
    try {
      const svc = getIntegrationService();
      return await svc.getOAuthAccessToken(this.slug, accountId);
    } catch {
      return '';
    }
  }

  private async buildUrl(epConfig: EndpointConfig, params: Record<string, any>, options: CallOptions, accountId?: string): Promise<URL> {
    let urlPath = epConfig.endpoint.path;

    // Interpolate path params
    if (epConfig.path_params) {
      for (const [key, def] of Object.entries(epConfig.path_params)) {
        const value = params[key];
        if (value == null && def.required) {
          throw new Error(`${ LOG } Required path param "${ key }" missing`);
        }
        if (value != null) {
          urlPath = urlPath.replace(`{${ key }}`, encodeURIComponent(String(value)));
        }
      }
    }

    const url = new URL(this.baseUrl + urlPath);

    // Apply query params
    if (epConfig.query_params) {
      for (const [key, def] of Object.entries(epConfig.query_params)) {
        const value = params[key] ?? def.default;
        if (value != null) {
          if (Array.isArray(value)) {
            value.forEach((v: any) => url.searchParams.append(key, String(v)));
          } else {
            url.searchParams.set(key, String(value));
          }
        } else if (def.required) {
          throw new Error(`${ LOG } Required query param "${ key }" missing`);
        }
      }
    }

    // Pagination token
    if (options.pageToken && epConfig.pagination?.type === 'nextPageToken') {
      const tokenKey = epConfig.pagination.next_token_path || 'pageToken';
      url.searchParams.set(tokenKey, options.pageToken);
    }

    // API key fallback
    const auth = this.integration.auth;
    if (auth.api_key_fallback?.enabled) {
      const apiKey = options.apiKey || await this.resolveCredential('api_key', auth.api_key_fallback.value, accountId);
      if (apiKey) {
        url.searchParams.set(auth.api_key_fallback.param_name, apiKey);
      }
    }

    return url;
  }

  private async buildHeaders(epConfig: EndpointConfig, options: CallOptions, accountId?: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Referer: 'https://sulla.app', ...this.defaultHeaders, ...options.headers };
    const authConfig = this.integration.auth.auth;

    if (options.token) {
      headers.Authorization = `Bearer ${ options.token }`;
    } else if (authConfig.type === 'oauth2') {
      // Try to get a valid OAuth token from the credential store
      const token = await this.getOAuthToken(accountId);
      if (token) {
        headers.Authorization = `Bearer ${ token }`;
      }
    } else if (authConfig.type === 'bearer') {
      const token = await this.resolveCredential('bearer_token', authConfig.client_secret, accountId);
      if (token) {
        headers.Authorization = `Bearer ${ token }`;
      }
    } else if (authConfig.type === 'apiKey' && authConfig.header) {
      const key = await this.resolveCredential('api_key', authConfig.client_secret, accountId);
      if (key) {
        headers[authConfig.header] = key;
      }
    }

    return headers;
  }

  private extractPaginated<T>(data: any, pagination: PaginationConfig, response?: { items_path?: string }): PaginatedResult<T> {
    const itemsPath = pagination.items_path || response?.items_path || 'items';
    const items = getNested(data, itemsPath) ?? [];

    let nextPageToken: string | undefined;
    if (pagination.type === 'nextPageToken' && pagination.next_token_path) {
      nextPageToken = getNested(data, pagination.next_token_path);
    }

    let prevPageToken: string | undefined;
    if (pagination.prev_token_path) {
      prevPageToken = getNested(data, pagination.prev_token_path);
    }

    return { items, nextPageToken, prevPageToken, raw: data };
  }

  private resolveEnvValue(value: string): string {
    const match = /^\$\{(.+)\}$/.exec(value);
    if (match) {
      return process.env[match[1]] || '';
    }
    return value;
  }
}

// ── Utilities ───────────────────────────────────────────────────

function getNested(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function isPaginatedResult<T>(value: any): value is PaginatedResult<T> {
  return value != null && typeof value === 'object' && 'items' in value && 'raw' in value;
}
