import { requireConfiguredCredentialBroker, usesContainerVaultAuthority, VaultBrokerError } from '../../../vault-broker';
import { getIntegrationService } from '../../services/IntegrationService';

import type {
  EndpointConfig,
  LoadedIntegration,
  PaginationConfig,
} from './types';

const LOG = '[ConfigApiClient]';

/**
 * Error thrown when an upstream integration API returns a non-OK response.
 * Preserves the structured error body so callers can inspect status, method, and details.
 */
export class IntegrationApiError extends Error {
  public readonly statusCode:    number;
  public readonly method:        string;
  public readonly path:          string;
  public readonly upstreamError: any;

  constructor(statusCode: number, method: string, path: string, upstreamError: any) {
    const summary = typeof upstreamError === 'string' ? upstreamError : JSON.stringify(upstreamError);
    super(`${ LOG } ${ method } ${ path } returned ${ statusCode }: ${ summary }`);
    this.name = 'IntegrationApiError';
    this.statusCode = statusCode;
    this.method = method;
    this.path = path;
    this.upstreamError = upstreamError;
  }
}

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
  /** Verified or trusted-bound caller identity for container vault routing. */
  executionContext?: import('../../tools/executionContext').ToolExecutionContext;
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
 * Credentials are resolved exclusively from the IntegrationService:
 *   1. Explicit `options.token` / `options.apiKey` passed at call time
 *   2. IntegrationService DB values (slug = folder name, e.g. "youtube")
 *
 * YAML `${ENV_VAR}` placeholders are only used for non-credential values.
 * All secrets (bearer tokens, API keys, base URLs) must be stored via
 * Settings → Integrations in the Sulla UI.
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

  /**
   * Resolve the effective base URL from IntegrationService.
   * Falls back to the raw YAML value only if it is a literal (non-placeholder) URL.
   */
  private async resolveBaseUrl(accountId?: string): Promise<string> {
    // Always try IntegrationService first — it is the source of truth
    const resolved = await this.resolveCredential('base_url', undefined, accountId);
    if (resolved) {
      return resolved.replace(/\/+$/, '');
    }

    // Fall back to the YAML value only if it's a literal URL (not a placeholder)
    const raw = this.integration.auth.api.base_url;
    if (/\$\{.+\}/.test(raw)) {
      console.warn(`${ LOG } base_url for "${ this.slug }" is a placeholder (${ raw }) but no value found in IntegrationService. Configure it via Settings → Integrations.`);
      return '';
    }
    return this.baseUrl;
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
   * If the endpoint or integration uses transport: 'mcp', the call is
   * routed through MCPBridge instead of a standard HTTP fetch.
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

    // Route MCP-transport endpoints through MCPBridge
    const transport = epConfig.endpoint.transport || this.integration.auth.api.transport || 'rest';
    if (transport === 'mcp') {
      return this.callMCP<T>(endpointName, params, options);
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

    const res = usesContainerVaultAuthority()
      ? await this.callBroker(url, fetchInit, epConfig, options)
      : await fetch(url.toString(), fetchInit);

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      let parsed: any = errText;
      try {
        parsed = JSON.parse(errText);
      } catch { /* keep as string */ }
      throw new IntegrationApiError(res.status, ep.method, ep.path, parsed);
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
   * Route an endpoint call through MCPBridge for MCP-transport integrations.
   * The MCP account ID is resolved from the auth config's mcp.account_id field.
   */
  private async callMCP<T>(
    endpointName: string,
    params: Record<string, any>,
    options: CallOptions,
  ): Promise<T> {
    const accountId = options.accountId || this.integration.auth.mcp?.account_id;
    if (!accountId) {
      throw new Error(`${ LOG } MCP transport requires an account_id (integration: ${ this.slug })`);
    }

    // Dynamic import to avoid circular deps and to keep MCPBridge out of the renderer bundle
    const { MCPBridge } = await import('../mcp/MCPBridge');
    const bridge = MCPBridge.getInstance();

    const result = await bridge.callTool(accountId, endpointName, params, options.executionContext);

    if (result.isError) {
      throw new Error(`${ LOG } MCP tool "${ endpointName }" returned error: ${ JSON.stringify(result.content) }`);
    }

    return result as unknown as T;
  }

  /**
   * Resolve a credential value from the IntegrationService.
   * This is the ONLY source for secrets (tokens, keys, URLs).
   * YAML placeholders like ${ENV_VAR} are never used for credentials.
   */
  private async resolveCredential(property: string, _yamlValue?: string, accountId?: string): Promise<string> {
    try {
      const svc = getIntegrationService();
      const dbValue = await svc.getIntegrationValue(this.slug, property, accountId);
      if (dbValue?.value) {
        return dbValue.value;
      }
      console.warn(`${ LOG } No "${ property }" found in IntegrationService for "${ this.slug }" (account: ${ accountId || 'active' }). Configure it via Settings → Integrations.`);
    } catch (err: any) {
      console.error(`${ LOG } IntegrationService error resolving "${ property }" for "${ this.slug }":`, err?.message || err);
    }

    return '';
  }

  private async callBroker(url: URL, init: RequestInit, endpoint: EndpointConfig, options: CallOptions): Promise<Response> {
    if (options.token || options.apiKey) {
      throw new Error('unsupported_secret_egress: explicit credential overrides are unavailable in Desktop vault mode');
    }

    const headers = new Headers(init.headers);
    headers.delete('authorization');
    headers.delete('x-api-key');
    headers.delete('api-key');
    const directInit = { ...init, headers };

    // Public catalog endpoints do not need a vault account, an unlocked vault,
    // or a signed credential scope. Decide that before consulting vault-backed
    // metadata so auth:none integrations remain usable while the vault is
    // locked or has not been configured yet.
    if (endpoint.endpoint.auth === 'none') {
      return fetch(url, directInit);
    }

    const ctx = options.executionContext;
    if (!ctx) throw new Error('catalog.http requires a verified execution context');
    const accountId = options.accountId || await getIntegrationService().getActiveAccountId(this.slug);
    if (ctx.credential_scope?.integration_id !== this.slug || ctx.credential_scope.account_id !== accountId) {
      throw new Error('catalog.http requires a signed credential scope for the selected integration account');
    }

    const auth = this.integration.auth;
    const injections: import('../../../vault-broker').BrokerInjection[] = [];
    if (auth.auth.type === 'oauth2') {
      injections.push({ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' });
    } else if (auth.auth.type === 'bearer') {
      injections.push({ field: 'bearer_token', target: 'header', name: 'authorization', scheme: 'Bearer' });
    } else if (auth.auth.type === 'apiKey' && auth.auth.header) {
      injections.push({ field: 'api_key', target: 'header', name: auth.auth.header, scheme: 'raw' });
    } else if (auth.api_key_fallback?.enabled) {
      injections.push({ field: 'api_key', target: 'query', name: auth.api_key_fallback.param_name, scheme: 'raw' });
    }
    let body: unknown = typeof init.body === 'string' ? init.body : undefined;
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch { /* preserve non-JSON request body */ }
    }
    const broker = requireConfiguredCredentialBroker();
    try {
      const result = await broker.execute(broker.requestFor(ctx, {
        operation: 'catalog.http',
        ref:       { integrationId: this.slug, accountId },
        url:       url.toString(),
        method:    init.method ?? 'GET',
        headers:   Object.fromEntries(headers.entries()),
        body,
        injections,
        responseType: 'json',
      }), init.signal ?? undefined);
      return new Response(result.body == null ? null : JSON.stringify(result.body), {
        status:  result.status,
        headers: result.headers,
      });
    } catch (error) {
      if (endpoint.endpoint.auth === 'optional' && error instanceof VaultBrokerError && error.code === 'credential_field_missing') {
        return fetch(url, directInit);
      }
      throw error;
    }
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

    const effectiveBaseUrl = await this.resolveBaseUrl(accountId);
    const url = new URL(effectiveBaseUrl + urlPath);

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
    if (!usesContainerVaultAuthority() && auth.api_key_fallback?.enabled) {
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

    if (usesContainerVaultAuthority()) {
      delete headers.Authorization;
      delete headers.authorization;
      return headers;
    }
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
