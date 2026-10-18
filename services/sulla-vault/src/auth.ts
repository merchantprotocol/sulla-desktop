import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { AccountsIdentityError, resolveAccountsContext } from './accountsIdentity.js';

import type { VaultConfig } from './config.js';
import type { Queryable } from './db.js';
import type { NextFunction, Request, Response } from 'express';

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId:          string;
    source:          'vault' | 'accounts';
    issuer?:         string;
    subject?:        string;
    authorityId?:    string;
    organizationId?: string;
  };
}

export function makeLoginVerifier(loginHash: string, salt = randomBytes(16)): { salt: Buffer; verifier: Buffer } {
  return { salt, verifier: scryptSync(loginHash, salt, 32) };
}

export function verifyLoginHash(loginHash: string, salt: Uint8Array, expected: Uint8Array): boolean {
  const actual = scryptSync(loginHash, salt, expected.byteLength);
  return timingSafeEqual(actual, expected);
}

export function issueToken(config: VaultConfig, userId: string): string {
  return jwt.sign({ sub: userId, aud: 'sulla-vault' }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '12h' });
}

export function authenticate(config: VaultConfig, db: Queryable) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) {
      response.status(401).json({ error: 'authentication_required' });
      return;
    }
    const authorityId = request.header('x-sulla-authority-id');
    const organizationId = request.header('x-sulla-organization-id');
    if (authorityId || organizationId) {
      if (config.mode !== 'server' || !authorityId || !organizationId) {
        response.status(403).json({ error: 'accounts_context_required' });
        return;
      }
      resolveAccountsContext(config, { bearerToken: token, authorityId, organizationId }).then(async(context) => {
        const mapped = await db.query<{ user_id: string }>(
          `SELECT ai.user_id FROM accounts_identities ai
            JOIN org_members om ON om.user_id=ai.user_id AND om.org_id=$3 AND om.status='confirmed'
           WHERE ai.issuer=$1 AND ai.subject=$2`,
          [context.issuer, context.subject, context.organizationId],
        );
        if (!mapped.rows[0]?.user_id) {
          throw new AccountsIdentityError(403, 'Accounts identity is not linked to this Vault organization');
        }
        request.auth = { userId: mapped.rows[0].user_id, source: 'accounts', issuer: context.issuer,
          subject: context.subject, authorityId: context.authorityId, organizationId: context.organizationId };
        next();
      }).catch((error: unknown) => {
        const status = error instanceof AccountsIdentityError ? error.status : 403;
        response.status(status).json({ error: status === 401 ? 'invalid_accounts_token' : 'accounts_access_denied' });
      });
      return;
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: 'sulla-vault' });
      if (typeof payload === 'string' || typeof payload.sub !== 'string') {
        throw new Error('Invalid token subject');
      }
      request.auth = { userId: payload.sub, source: 'vault' };
      next();
    } catch {
      response.status(401).json({ error: 'invalid_token' });
    }
  };
}

export async function ensureDesktopAccount(db: Queryable, config: VaultConfig): Promise<void> {
  if (config.mode !== 'desktop' || !config.desktopLoginHash) {
    return;
  }
  if (!config.desktopPublicKey || !config.desktopEncryptedPrivateKey || !config.desktopEncryptedUserKey || !config.desktopKdf) {
    throw new Error('Desktop bootstrap requires public key, wrapped private key, wrapped user key, and KDF settings');
  }
  const existing = await db.query('SELECT id FROM users LIMIT 1');
  if (existing.rowCount) {
    return;
  }
  const { salt, verifier } = makeLoginVerifier(config.desktopLoginHash);
  await db.query(
    `INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['desktop@local.sulla', salt, verifier, config.desktopPublicKey, config.desktopEncryptedPrivateKey,
      config.desktopEncryptedUserKey, config.desktopKdf],
  );
}
