import yaml from 'yaml';

import type { VaultItemPlaintext } from '@sulla/vault-crypto';

import type { BrokerExecuteRequest } from './contracts.js';
import type { Database } from './db.js';

interface OAuthEndpoints { token: string; revoke?: string }
interface StoredDefinition { files: Record<string, string | { content?: string }> }
interface AuthDocument { auth?: { token_url?: string; revoke_url?: string; revocation_url?: string } }

const NATIVE_OAUTH_ENDPOINTS: Readonly<Record<string, OAuthEndpoints>> = {
  cloudflare: { token: 'https://dash.cloudflare.com/oauth2/token', revoke: 'https://dash.cloudflare.com/oauth2/revoke' },
  codex:      { token: 'https://auth.openai.com/oauth/token' },
  google:     { token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' },
  grok:       { token: 'https://auth.x.ai/oauth2/token', revoke: 'https://auth.x.ai/oauth2/revoke' },
  intuit:     { token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', revoke: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke' },
  openai:     { token: 'https://auth.openai.com/oauth/token' },
  robinhood:  { token: 'https://api.robinhood.com/oauth2/token/' },
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
  if (!['oauth.exchange', 'oauth.adopt', 'oauth.refresh', 'oauth.revoke'].includes(input.operation)) return;
  const integrationId = input.ref.integrationId ?? '';
  const properties = plaintext.integration?.properties ?? {};
  const providerId = properties.provider_id || properties.provider || INTEGRATION_PROVIDER_FALLBACK[integrationId];
  const nativeEndpoints = providerId ? NATIVE_OAUTH_ENDPOINTS[providerId] : undefined;
  const endpoints = nativeEndpoints ?? await manifestEndpoints(db, integrationId);
  const configured = input.operation === 'oauth.revoke' ? endpoints?.revoke : endpoints?.token;
  if (!configured || exactHttpsUrl(input.url) !== exactHttpsUrl(configured)) throw new Error('destination_denied');
}

export const oauthPolicyTestHooks = { NATIVE_OAUTH_ENDPOINTS };
