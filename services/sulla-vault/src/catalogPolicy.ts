import yaml from 'yaml';

import type { BrokerExecuteRequest, BrokerInjection } from './contracts.js';
import type { Database } from './db.js';

export interface CatalogPolicyDecision {
  credentialFree: boolean;
}

interface StoredDefinition { files: Record<string, string | { content?: string }> }
interface AuthDocument {
  api?: { base_url?: string; transport?: string };
  auth?: { type?: string; header?: string };
  api_key_fallback?: { enabled?: boolean; param_name?: string };
}
interface EndpointDocument {
  endpoint?: { path?: string; method?: string; auth?: string };
}

function exactInjection(left: BrokerInjection, right: BrokerInjection): boolean {
  return left.field === right.field && left.target === right.target &&
    left.name.toLowerCase() === right.name.toLowerCase() && (left.scheme ?? 'raw') === (right.scheme ?? 'raw');
}

function storedText(value: string | { content?: string } | undefined): string | null {
  return typeof value === 'string' ? value : typeof value?.content === 'string' ? value.content : null;
}

function endpointPattern(path: string): RegExp {
  const escaped = path.split(/(\{[^}]+\})/).map(part => part.startsWith('{')
    ? '[^/]+'
    : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${ escaped }$`);
}

function expectedInjection(auth: AuthDocument): BrokerInjection[] {
  if (auth.auth?.type === 'oauth2') {
    return [{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }];
  }
  if (auth.auth?.type === 'bearer') {
    return [{ field: 'bearer_token', target: 'header', name: 'authorization', scheme: 'Bearer' }];
  }
  if (auth.auth?.type === 'apiKey' && auth.auth.header) {
    return [{ field: 'api_key', target: 'header', name: auth.auth.header, scheme: 'raw' }];
  }
  if (auth.api_key_fallback?.enabled && auth.api_key_fallback.param_name) {
    return [{ field: 'api_key', target: 'query', name: auth.api_key_fallback.param_name, scheme: 'raw' }];
  }
  return [];
}

function validateInjections(input: BrokerExecuteRequest, allowed: BrokerInjection[], credentialFree: boolean): void {
  if (!input.injections.length && credentialFree) return;
  if (input.injections.length !== 1 || !allowed.some(candidate => exactInjection(candidate, input.injections[0]))) {
    throw new Error('injection_denied');
  }
}

/** Validate catalog/MCP traffic against the database-backed manifest shipped to this installation. */
export async function validateCatalogRequest(
  db: Database,
  input: BrokerExecuteRequest,
  target: URL,
): Promise<CatalogPolicyDecision> {
  if (input.operation === 'catalog.http' && input.ref.integrationId === 'google_drive') {
    const pathAllowed = /^\/(?:upload\/)?drive\/v3\//.test(target.pathname);
    if (target.hostname !== 'www.googleapis.com' || !pathAllowed ||
        !['GET', 'POST', 'PATCH', 'DELETE'].includes(input.method.toUpperCase())) throw new Error('destination_denied');
    validateInjections(input, [{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }], false);
    return { credentialFree: false };
  }

  const accountId = input.ref.accountId ?? '';
  const integrationId = input.ref.integrationId ?? '';
  const slug = input.operation === 'mcp.http'
    ? `mcp-${ accountId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') }`
    : integrationId;
  const result = await db.query<StoredDefinition>('SELECT files FROM integration_definitions WHERE slug=$1 LIMIT 1', [slug]);
  const files = result.rows[0]?.files;
  if (!files || typeof files !== 'object') throw new Error('manifest_not_found');
  const authName = Object.keys(files).find(name => /\.v\d+-auth\.ya?ml$/i.test(name));
  const authText = authName ? storedText(files[authName]) : null;
  if (!authText) throw new Error('manifest_invalid');
  const auth = yaml.parse(authText) as AuthDocument;
  if (!auth.api?.base_url) throw new Error('manifest_invalid');
  const base = new URL(auth.api.base_url);
  if (base.protocol !== 'https:' || base.origin !== target.origin) throw new Error('destination_denied');

  const endpoint = Object.entries(files)
    .filter(([name]) => /\.ya?ml$/i.test(name) && name !== authName)
    .map(([, value]) => storedText(value))
    .filter((value): value is string => Boolean(value))
    .map(value => yaml.parse(value) as EndpointDocument)
    .find(candidate => candidate.endpoint?.path && candidate.endpoint.method?.toUpperCase() === input.method.toUpperCase() &&
      endpointPattern(candidate.endpoint.path).test(target.pathname));

  if (input.operation === 'mcp.http') {
    const prefix = base.pathname.replace(/\/$/, '');
    if (!(target.pathname === prefix || target.pathname.startsWith(`${ prefix }/`)) ||
        !['GET', 'POST', 'DELETE'].includes(input.method.toUpperCase())) throw new Error('destination_denied');
    const credentialFree = endpoint?.endpoint?.auth === 'none' || endpoint?.endpoint?.auth === 'optional';
    validateInjections(input, [{ field: 'auth_token', target: 'header', name: 'authorization', scheme: 'Bearer' }], credentialFree);
    return { credentialFree: input.injections.length === 0 && credentialFree };
  }

  if (!endpoint?.endpoint) throw new Error('endpoint_denied');
  const credentialFree = endpoint.endpoint.auth === 'none' || endpoint.endpoint.auth === 'optional';
  validateInjections(input, expectedInjection(auth), credentialFree);
  return { credentialFree };
}
