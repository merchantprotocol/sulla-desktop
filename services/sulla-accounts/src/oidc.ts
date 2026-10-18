import { createHash, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { assertTrustedUrl, normalizeIssuer } from './config.js';
import { base64url, decrypt, digest, encrypt } from './crypto.js';
import { fetchJson, object, string, stringArray } from './http.js';
import { verifyOidcToken } from './auth.js';

import type { AccountsConfig } from './config.js';
import type { Database } from './db.js';

export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
}

export interface Authority {
  id: string;
  issuer: string;
  client_id: string;
  audience: string;
  scopes: string[];
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  membership_endpoint?: string;
  subject?: string;
  connected_at?: Date;
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  scope?: string;
}

function issuerMetadataUrl(issuer: string): string {
  return `${issuer}${issuer.endsWith('/') ? '' : '/'}.well-known/openid-configuration`;
}

function callbackUrl(publicUrl: string): string {
  const url = new URL(publicUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/oidc/callback`;
  url.search = '';
  url.hash = '';
  return url.href;
}

export async function discover(issuerInput: string): Promise<Discovery> {
  const issuer = normalizeIssuer(issuerInput);
  const document = object(await fetchJson(issuerMetadataUrl(issuer)));
  if (string(document.issuer, 'issuer') !== issuer) throw new Error('discovery issuer mismatch');
  return {
    issuer,
    authorizationEndpoint: assertTrustedUrl(string(document.authorization_endpoint, 'authorization_endpoint'), issuer),
    tokenEndpoint: assertTrustedUrl(string(document.token_endpoint, 'token_endpoint'), issuer),
    jwksUri: assertTrustedUrl(string(document.jwks_uri, 'jwks_uri'), issuer),
    revocationEndpoint: typeof document.revocation_endpoint === 'string' ? assertTrustedUrl(document.revocation_endpoint, issuer) : undefined,
  };
}

export async function createAuthority(db: Database, input: Record<string, unknown>): Promise<Authority> {
  const issuer = string(input.issuer, 'issuer');
  const metadata = await discover(issuer);
  const clientId = string(input.clientId, 'clientId', 300);
  const audience = string(input.audience, 'audience', 300);
  const scopes = stringArray(input.scopes ?? ['openid', 'profile'], 'scopes', 20);
  if (!scopes.includes('openid')) throw new Error('scopes must include openid');
  const membershipEndpoint = input.membershipEndpoint === undefined ? undefined : assertTrustedUrl(string(input.membershipEndpoint, 'membershipEndpoint'), metadata.issuer);
  const id = randomUUID();
  const result = await db.query<Authority>(
    `INSERT INTO accounts.authorities
       (id, issuer, client_id, audience, scopes, authorization_endpoint, token_endpoint, jwks_uri, revocation_endpoint, membership_endpoint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, metadata.issuer, clientId, audience, scopes, metadata.authorizationEndpoint, metadata.tokenEndpoint, metadata.jwksUri, metadata.revocationEndpoint, membershipEndpoint],
  );
  return result.rows[0];
}

function safeReturnTo(config: AccountsConfig, input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const value = string(input, 'returnTo');
  const url = new URL(value);
  if (!config.allowedReturnOrigins.has(url.origin)) throw new Error('returnTo origin is not allowed');
  return url.href;
}

export async function beginAuthorization(db: Database, config: AccountsConfig, authority: Authority, returnInput: unknown): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const id = randomUUID();
  const state = base64url(32);
  const verifier = base64url(64);
  const nonce = base64url(32);
  const redirectUri = callbackUrl(config.publicUrl);
  const returnTo = safeReturnTo(config, returnInput);
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const protectedVerifier = encrypt(config.encryptionKey, verifier, `authorization_transactions:${id}:${authority.id}:v1`);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM accounts.authorities WHERE id=$1 FOR UPDATE', [authority.id]);
    await client.query(
      'UPDATE accounts.authorization_transactions SET consumed_at=now() WHERE authority_id=$1 AND consumed_at IS NULL',
      [authority.id],
    );
    await client.query(
      `INSERT INTO accounts.authorization_transactions
         (id, authority_id, state_digest, verifier_ciphertext, verifier_nonce, verifier_auth_tag, nonce, redirect_uri, return_to, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, authority.id, digest(state), protectedVerifier.ciphertext, protectedVerifier.nonce, protectedVerifier.authTag, nonce, redirectUri, returnTo, expiresAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  const url = new URL(authority.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', authority.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', authority.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  if (authority.audience) url.searchParams.set('audience', authority.audience);
  return { authorizationUrl: url.href, expiresAt: expiresAt.toISOString() };
}

export async function completeAuthorization(db: Database, config: AccountsConfig, code: string, state: string): Promise<{ authorityId: string; returnTo?: string }> {
  const client = await db.connect();
  let transaction: Record<string, unknown>;
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT t.*, a.issuer, a.client_id, a.audience, a.authorization_endpoint, a.token_endpoint, a.jwks_uri, a.revocation_endpoint
         FROM accounts.authorization_transactions t JOIN accounts.authorities a ON a.id=t.authority_id
        WHERE t.state_digest=$1 FOR UPDATE`, [digest(state)],
    );
    if (!found.rowCount) throw new Error('invalid state');
    transaction = found.rows[0];
    if (transaction.consumed_at || new Date(transaction.expires_at as string).getTime() <= Date.now()) throw new Error('expired or consumed state');
    await client.query('UPDATE accounts.authorization_transactions SET consumed_at=now() WHERE id=$1', [transaction.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  const pinnedIssuer = string(transaction.issuer, 'issuer');
  const currentMetadata = await discover(pinnedIssuer);
  if (
    currentMetadata.authorizationEndpoint !== transaction.authorization_endpoint ||
    currentMetadata.tokenEndpoint !== transaction.token_endpoint ||
    currentMetadata.jwksUri !== transaction.jwks_uri ||
    currentMetadata.revocationEndpoint !== (transaction.revocation_endpoint ?? undefined)
  ) throw new Error('authority discovery metadata changed during authorization');

  const authorityId = string(transaction.authority_id, 'authority id');
  const verifier = decrypt(config.encryptionKey, {
    ciphertext: transaction.verifier_ciphertext as Buffer,
    nonce: transaction.verifier_nonce as Buffer,
    authTag: transaction.verifier_auth_tag as Buffer,
  }, `authorization_transactions:${string(transaction.id, 'transaction id')}:${authorityId}:v1`);
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: string(transaction.client_id, 'client id'),
    redirect_uri: string(transaction.redirect_uri, 'redirect uri'), code_verifier: verifier,
  });
  const tokens = object(await fetchJson(string(transaction.token_endpoint, 'token endpoint'), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  }));
  const accessToken = string(tokens.access_token, 'access_token', 64 * 1024);
  const idToken = string(tokens.id_token, 'id_token', 64 * 1024);
  const identity = await verifyOidcToken(
    idToken,
    pinnedIssuer,
    string(transaction.client_id, 'client id'),
    string(transaction.jwks_uri, 'jwks uri'),
    { requireAuthorizedParty: true },
  );
  const claims = jwt.decode(idToken);
  if (!claims || typeof claims === 'string' || claims.nonce !== transaction.nonce) throw new Error('ID token nonce mismatch');
  const stored = JSON.stringify({ accessToken, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined, idToken, tokenType: tokens.token_type, scope: tokens.scope });
  const protectedSession = encrypt(config.encryptionKey, stored, `authority_sessions:${authorityId}:${authorityId}:v1`);
  const expiresAt = typeof tokens.expires_in === 'number' ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  const writer = await db.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT 1 FROM accounts.authorities WHERE id=$1 FOR UPDATE', [authorityId]);
    const newest = await writer.query(
      'SELECT id FROM accounts.authorization_transactions WHERE authority_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [authorityId],
    );
    if (newest.rows[0]?.id !== transaction.id) throw new Error('authorization was superseded');
    await writer.query(
      `INSERT INTO accounts.authority_sessions(authority_id,ciphertext,nonce,auth_tag,access_expires_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (authority_id) DO UPDATE SET
         ciphertext=EXCLUDED.ciphertext, nonce=EXCLUDED.nonce, auth_tag=EXCLUDED.auth_tag,
         access_expires_at=EXCLUDED.access_expires_at, updated_at=now()`,
      [authorityId, protectedSession.ciphertext, protectedSession.nonce, protectedSession.authTag, expiresAt],
    );
    await writer.query('UPDATE accounts.authorities SET subject=$2, connected_at=now(), updated_at=now() WHERE id=$1', [authorityId, identity.subject]);
    await writer.query('COMMIT');
  } catch (error) {
    await writer.query('ROLLBACK');
    throw error;
  } finally { writer.release(); }
  return { authorityId, returnTo: typeof transaction.return_to === 'string' ? transaction.return_to : undefined };
}

function decodeStoredSession(config: AccountsConfig, authorityId: string, row: Record<string, unknown>): StoredTokens {
  return JSON.parse(decrypt(config.encryptionKey, {
    ciphertext: row.ciphertext as Buffer,
    nonce: row.nonce as Buffer,
    authTag: row.auth_tag as Buffer,
  }, `authority_sessions:${authorityId}:${authorityId}:v1`)) as StoredTokens;
}

export async function authorityAccessToken(db: Database, config: AccountsConfig, authority: Authority): Promise<string> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT * FROM accounts.authority_sessions WHERE authority_id=$1 FOR UPDATE',
      [authority.id],
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('authority is not authorized');
    const stored = decodeStoredSession(config, authority.id, row);
    const expiresAt = row.access_expires_at ? new Date(row.access_expires_at as string).getTime() : undefined;
    if (!expiresAt || expiresAt > Date.now() + 30_000) {
      await client.query('COMMIT');
      return string(stored.accessToken, 'stored access token', 64 * 1024);
    }
    if (!stored.refreshToken) throw new Error('authority session expired');
    const refreshed = object(await fetchJson(authority.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: authority.client_id, refresh_token: stored.refreshToken }),
    }));
    const next: StoredTokens = {
      ...stored,
      accessToken: string(refreshed.access_token, 'access_token', 64 * 1024),
      refreshToken: typeof refreshed.refresh_token === 'string' ? refreshed.refresh_token : stored.refreshToken,
      idToken: typeof refreshed.id_token === 'string' ? refreshed.id_token : stored.idToken,
      tokenType: typeof refreshed.token_type === 'string' ? refreshed.token_type : stored.tokenType,
      scope: typeof refreshed.scope === 'string' ? refreshed.scope : stored.scope,
    };
    const protectedSession = encrypt(config.encryptionKey, JSON.stringify(next), `authority_sessions:${authority.id}:${authority.id}:v1`);
    const nextExpiry = typeof refreshed.expires_in === 'number' ? new Date(Date.now() + refreshed.expires_in * 1000) : null;
    await client.query(
      'UPDATE accounts.authority_sessions SET ciphertext=$2,nonce=$3,auth_tag=$4,access_expires_at=$5,updated_at=now() WHERE authority_id=$1',
      [authority.id, protectedSession.ciphertext, protectedSession.nonce, protectedSession.authTag, nextExpiry],
    );
    await client.query('COMMIT');
    return next.accessToken;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function revokeAuthoritySession(db: Database, config: AccountsConfig, authority: Authority): Promise<void> {
  const found = await db.query('SELECT * FROM accounts.authority_sessions WHERE authority_id=$1', [authority.id]);
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row && authority.revocation_endpoint) {
    const stored = decodeStoredSession(config, authority.id, row);
    const token = stored.refreshToken ?? stored.accessToken;
    try {
      await fetchJson(authority.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: authority.client_id }),
      }, 64 * 1024);
    } catch { /* Local deletion still revokes this installation's access. */ }
  }
  await db.query('DELETE FROM accounts.authorities WHERE id=$1', [authority.id]);
}

export async function ensureHostedAuthority(db: Database, config: AccountsConfig): Promise<void> {
  if (config.mode !== 'server' || !config.keycloakIssuer || !config.keycloakAudience) return;
  const existing = await db.query('SELECT 1 FROM accounts.authorities WHERE issuer=$1', [config.keycloakIssuer]);
  if (existing.rowCount) return;
  const metadata = await discover(config.keycloakIssuer);
  await db.query(
    `INSERT INTO accounts.authorities(id,issuer,client_id,audience,scopes,authorization_endpoint,token_endpoint,jwks_uri,revocation_endpoint)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8) ON CONFLICT (issuer) DO NOTHING`,
    [randomUUID(), metadata.issuer, config.keycloakAudience, ['openid', 'profile'], metadata.authorizationEndpoint, metadata.tokenEndpoint, metadata.jwksUri, metadata.revocationEndpoint],
  );
}
