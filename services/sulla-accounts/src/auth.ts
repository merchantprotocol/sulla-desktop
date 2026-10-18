import { createPublicKey, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { digest, equalSecret } from './crypto.js';
import { fetchJson, object, string } from './http.js';

import type { AccountsConfig } from './config.js';
import type { Database, Queryable } from './db.js';
import type { NextFunction, Request, Response } from 'express';

export interface OwnerRequest extends Request {
  owner?: { profileId: string; jti: string };
}

export interface ServiceRequest extends Request {
  service?: { id: string; issuers: Set<string>; allowedAudiences: Set<string>; pathPrefixes: string[]; methods: Set<string> };
}

function bearer(request: Request): string | undefined {
  return request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
}

export async function issueOwnerSession(db: Queryable, config: AccountsConfig, profileId: string): Promise<{ token: string; expiresAt: string }> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await db.query('INSERT INTO accounts.broker_sessions(jti_digest, profile_id, expires_at) VALUES ($1, $2, $3)', [digest(jti), profileId, expiresAt]);
  const token = jwt.sign({}, config.sessionSecret, {
    algorithm: 'HS256', audience: 'sulla-accounts', issuer: config.publicUrl,
    subject: profileId, jwtid: jti, expiresIn: '15m',
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

export function authenticateOwner(db: Database, config: AccountsConfig) {
  return async (request: OwnerRequest, response: Response, next: NextFunction): Promise<void> => {
    try {
      request.owner = await verifyOwnerSession(db, config, bearer(request));
      next();
    } catch {
      response.status(401).json({ error: 'invalid_session' });
    }
  };
}

export async function verifyOwnerSession(db: Database, config: AccountsConfig, token: string | undefined): Promise<{ profileId: string; jti: string }> {
  if (!token) throw new Error('missing owner token');
  const payload = jwt.verify(token, config.sessionSecret, { algorithms: ['HS256'], audience: 'sulla-accounts', issuer: config.publicUrl });
  if (typeof payload === 'string' || !payload.sub || !payload.jti || typeof payload.exp !== 'number' || payload.exp <= Date.now() / 1000) {
    throw new Error('invalid owner session');
  }
  const row = await db.query(
    'SELECT 1 FROM accounts.broker_sessions WHERE jti_digest = $1 AND profile_id = $2 AND revoked_at IS NULL AND expires_at > now()',
    [digest(payload.jti), payload.sub],
  );
  if (!row.rowCount) throw new Error('revoked owner session');
  return { profileId: payload.sub, jti: payload.jti };
}

export function authenticateStatic(expected: Buffer | undefined) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!equalSecret(bearer(request), expected)) { response.status(401).json({ error: 'authentication_required' }); return; }
    next();
  };
}

export function authenticateService(config: AccountsConfig) {
  return (request: ServiceRequest, response: Response, next: NextFunction): void => {
    const serviceId = request.header('x-sulla-service-id');
    const grant = serviceId ? config.serviceTokens.get(serviceId) : undefined;
    if (!equalSecret(request.header('x-sulla-service-token'), grant?.token)) { response.status(401).json({ error: 'service_authentication_required' }); return; }
    request.service = {
      id: serviceId!,
      issuers: grant!.issuers,
      allowedAudiences: grant!.allowedAudiences,
      pathPrefixes: grant!.pathPrefixes,
      methods: grant!.methods,
    };
    next();
  };
}

export async function verifyOidcToken(
  token: string,
  issuer: string,
  audience: string,
  jwksUri: string,
  options: { requireAuthorizedParty?: boolean } = {},
): Promise<{ issuer: string; subject: string }> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || typeof decoded.header.kid !== 'string' || typeof decoded.header.alg !== 'string') throw new Error('token has no key id or algorithm');
  const allowedAlgorithms = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'] as const;
  if (!(allowedAlgorithms as readonly string[]).includes(decoded.header.alg)) throw new Error('token algorithm is not allowed');
  const jwks = object(await fetchJson(jwksUri));
  if (!Array.isArray(jwks.keys)) throw new Error('invalid JWKS');
  const matches = jwks.keys.filter(candidate => {
    const value = object(candidate);
    if (value.kid !== decoded.header.kid || (value.use !== undefined && value.use !== 'sig')) return false;
    if (Array.isArray(value.key_ops) && !value.key_ops.includes('verify')) return false;
    if (value.alg !== undefined && value.alg !== decoded.header.alg) return false;
    return decoded.header.alg.startsWith('RS') ? value.kty === 'RSA' : value.kty === 'EC';
  });
  if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous signing key' : 'signing key not found');
  const key = matches[0];
  const publicKey = createPublicKey({ key: key as import('node:crypto').JsonWebKey, format: 'jwk' });
  const payload = jwt.verify(token, publicKey, { algorithms: [...allowedAlgorithms], issuer, audience });
  if (typeof payload === 'string') throw new Error('invalid token');
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) throw new Error('token expiry is invalid');
  if (payload.iss !== issuer) throw new Error('token issuer is invalid');
  if (options.requireAuthorizedParty && Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== audience) {
    throw new Error('token authorized party is invalid');
  }
  return { issuer: string(payload.iss, 'issuer'), subject: string(payload.sub, 'subject') };
}

export function getBearer(request: Request): string | undefined { return bearer(request); }
