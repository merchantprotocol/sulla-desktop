import yaml from 'yaml';

import type { VaultItemPlaintext } from '@sulla/vault-crypto';

import type { BrokerExecuteRequest } from './contracts.js';
import type { Database } from './db.js';

interface OAuthEndpoints { token: string; revoke?: string; register?: string }
interface StoredDefinition { files: Record<string, string | { content?: string }> }
interface AuthDocument { auth?: { token_url?: string; revoke_url?: string; revocation_url?: string } }

const NATIVE_OAUTH_ENDPOINTS: Readonly<Record<string, OAuthEndpoints>> = {
  cloudflare: { token: 'https://dash.cloudflare.com/oauth2/token', revoke: 'https://dash.cloudflare.com/oauth2/revoke' },
  codex:      { token: 'https://auth.openai.com/oauth/token' },
  google:     { token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' },
  grok:       { token: 'https://auth.x.ai/oauth2/token', revoke: 'https://auth.x.ai/oauth2/revoke' },
  intuit:     { token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', revoke: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke' },
  openai:     { token: 'https://auth.openai.com/oauth/token' },
  robinhood:  { token: 'https://api.robinhood.com/oauth2/token/', register: 'https://agent.robinhood.com/oauth/trading/register' },
};

const INTEGRATION_PROVIDER_FALLBACK: Readonly<Record<string, string>> = {
  gmail: 'google', google_drive: 'google', cloudflare: 'cloudflare', codex: 'codex',
  grok: 'grok', openai: 'openai', robinhood: 'robinhood', quickbooks: 'intuit',
};

function storedText(value: string | { content?: string } | undefined): string | null {
  return typeof value === 'string' ? value : typeof value?.content === 'string' ? value.content : null;
}

function exactHttpsUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('destination_denied');
  return url.toString();
}

async function manifestEndpoints(db: Database, integrationId: string): Promise<OAuthEndpoints | null> {
  const result = await db.query<StoredDefinition>('SELECT files FROM integration_definitions WHERE slug=$1 LIMIT 1', [integrationId]);
  const files = result.rows[0]?.files;
  if (!files) return null;
  for (const [name, value] of Object.entries(files)) {
    if (!/\.v\d+-auth\.ya?ml$/i.test(name)) continue;
    const text = storedText(value);
    if (!text) continue;
    const auth = (yaml.parse(text) as AuthDocument).auth;
    if (auth?.token_url) return { token: auth.token_url, revoke: auth.revoke_url ?? auth.revocation_url };
  }
  return null;
}

/** Bind typed OAuth custody calls to provider-owned endpoints, never caller-selected URLs. */
export async function validateOAuthDestination(
  db: Database,
  input: BrokerExecuteRequest,
  plaintext: VaultItemPlaintext,
): Promise<void> {
  if (!['oauth.exchange', 'oauth.adopt', 'oauth.refresh', 'oauth.revoke', 'oauth.register'].includes(input.operation)) return;
  const integrationId = input.ref.integrationId ?? '';
  const properties = plaintext.integration?.properties ?? {};
  const providerId = properties.provider_id || properties.provider || INTEGRATION_PROVIDER_FALLBACK[integrationId];
  const nativeEndpoints = providerId ? NATIVE_OAUTH_ENDPOINTS[providerId] : undefined;
  const endpoints = nativeEndpoints ?? await manifestEndpoints(db, integrationId);
  const configured = input.operation === 'oauth.revoke'
    ? endpoints?.revoke
    : input.operation === 'oauth.register' ? endpoints?.register : endpoints?.token;
  if (!configured || exactHttpsUrl(input.url) !== exactHttpsUrl(configured)) throw new Error('destination_denied');
  if (input.operation === 'oauth.register') validateOAuthRegistrationRequest(input.body);
}

/** Validate the exact bounded public-client metadata accepted by Robinhood DCR. */
export function validateOAuthRegistrationRequest(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_registration_metadata');
  const metadata = body as Record<string, unknown>;
  const allowed = new Set(['client_name', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'redirect_uris']);
  if (Object.keys(metadata).some(name => !allowed.has(name)) || Buffer.byteLength(JSON.stringify(metadata)) > 16 * 1024) {
    throw new Error('invalid_registration_metadata');
  }
  if (typeof metadata.client_name !== 'string' || metadata.client_name.length < 1 || metadata.client_name.length > 128 ||
      metadata.token_endpoint_auth_method !== 'none') throw new Error('invalid_registration_metadata');
  const grantTypes = metadata.grant_types;
  const responseTypes = metadata.response_types;
  const redirects = metadata.redirect_uris;
  if (!Array.isArray(grantTypes) || grantTypes.length < 1 || grantTypes.length > 2 ||
      grantTypes.some(value => !['authorization_code', 'refresh_token'].includes(String(value))) ||
      !Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code' ||
      !Array.isArray(redirects) || redirects.length !== 1 || typeof redirects[0] !== 'string' || redirects[0].length > 512) {
    throw new Error('invalid_registration_metadata');
  }
  const redirect = new URL(redirects[0]);
  if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) ||
      !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error('invalid_registration_metadata');
  }
}

export const oauthPolicyTestHooks = { NATIVE_OAUTH_ENDPOINTS };
