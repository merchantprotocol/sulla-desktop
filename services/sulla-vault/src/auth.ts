import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import jwt from 'jsonwebtoken';

import type { VaultConfig } from './config.js';
import type { Queryable } from './db.js';
import type { NextFunction, Request, Response } from 'express';

export interface AuthenticatedRequest extends Request {
  auth?: { userId: string };
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

export function authenticate(config: VaultConfig) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) {
      response.status(401).json({ error: 'authentication_required' });
      return;
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: 'sulla-vault' });
      if (typeof payload === 'string' || typeof payload.sub !== 'string') {
        throw new Error('Invalid token subject');
      }
      request.auth = { userId: payload.sub };
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
