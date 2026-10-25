// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// Vault-origin browser sessions (the server twin of Sulla Cloud's
// cloud-vault-sync browser session). The console, which holds the user's
// sign-in, asks the Console API to mint a one-time handoff code (60 seconds,
// single use, stored hashed). The vault page on vault.<host> trades it for a
// `__Host-sulla_vault` HttpOnly, Secure, SameSite=Strict cookie whose SHA-256
// is the only thing stored. Sessions last at most 12 hours.
//
// A cookie request must also arrive on the vault hostname, from the vault
// Origin (or Sec-Fetch-Site: same-origin when the browser sends no Origin),
// and carry `X-Sulla-Vault-Request: 1`, so script on the console origin can't
// drive these routes with the cookie.

import { createHash, createHmac, randomBytes } from 'node:crypto';

import type { BrowserSyncConfig } from './config.js';
import type { Queryable } from '../db.js';
import type { Request } from 'express';

export const SESSION_COOKIE = '__Host-sulla_vault';
export const CSRF_HEADER = 'x-sulla-vault-request';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const HANDOFF_TTL_MS = 60 * 1000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface BrowserSession {
  id:        string;
  userId:    string;
  orgId:     string;
  orgLabel:  string | null;
  createdAt: string;
  expiresAt: string;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A short keyed hash so the audit can tell sessions apart without storing an address. */
export function keyedHash(secret: string, purpose: string, value: string | undefined): string | null {
  if (!value) return null;
  return createHmac('sha256', secret).update(`sulla-vault-browser:${ purpose }\0${ value }`).digest('hex').slice(0, 16);
}

/** The request's hostname from the Host header, lowercased, without a port. */
export function requestHost(request: Request): string {
  const host = request.headers.host ?? '';
  return host.replace(/:\d+$/, '').toLowerCase();
}

export function onVaultHost(config: BrowserSyncConfig, request: Request): boolean {
  return Boolean(config.vaultHost) && requestHost(request) === config.vaultHost;
}

/** True when a cookie-carrying request plausibly comes from the vault page itself. */
export function vaultRequestAllowed(config: BrowserSyncConfig, request: Request): boolean {
  if (!onVaultHost(config, request)) return false;
  if (request.header(CSRF_HEADER) !== '1') return false;
  const origin = request.header('origin');
  if (!origin) return request.header('sec-fetch-site') === 'same-origin';
  return origin === config.vaultOrigin;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${ SESSION_COOKIE }=${ token }; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${ maxAgeSeconds }`;
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return TOKEN.test(value) ? value : null;
    }
  }
  return null;
}

/** Console side (bearer): mint a single-use code for the vault origin. */
export async function createHandoff(
  db: Queryable, userId: string, orgId: string, orgLabel: string | null,
): Promise<{ code: string; expiresAt: string }> {
  const code = randomToken();
  const expires = new Date(Date.now() + HANDOFF_TTL_MS);
  await db.query(
    'DELETE FROM browser_sync_handoffs WHERE user_id = $1 AND (used_at IS NOT NULL OR expires_at < now())',
    [userId],
  );
  await db.query(
    'INSERT INTO browser_sync_handoffs(code_hash, user_id, org_id, org_label, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [sha256Hex(code), userId, orgId, orgLabel, expires],
  );
  return { code, expiresAt: expires.toISOString() };
}

/** Vault origin side: trade a handoff code for a session token, once. */
export async function exchangeHandoff(
  db: Queryable, code: unknown, meta: { ipHash: string | null; uaHash: string | null },
): Promise<{ token: string; session: BrowserSession } | null> {
  if (typeof code !== 'string' || !TOKEN.test(code)) return null;
  const claimed = await db.query<{ user_id: string; org_id: string; org_label: string | null }>(
    `UPDATE browser_sync_handoffs SET used_at = now()
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, org_id, org_label`,
    [sha256Hex(code)],
  );
  const row = claimed.rows[0];
  if (!row) return null;
  const token = randomToken();
  const created = await db.query<{ id: string; created_at: Date; expires_at: Date }>(
    `INSERT INTO browser_sync_sessions(token_hash, user_id, org_id, org_label, ip_hash, ua_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::text || ' milliseconds')::interval)
     RETURNING id, created_at, expires_at`,
    [sha256Hex(token), row.user_id, row.org_id, row.org_label, meta.ipHash, meta.uaHash, String(SESSION_TTL_MS)],
  );
  const session = created.rows[0];
  return {
    token,
    session: {
      id:        session.id,
      userId:    row.user_id,
      orgId:     row.org_id,
      orgLabel:  row.org_label,
      createdAt: session.created_at.toISOString(),
      expiresAt: session.expires_at.toISOString(),
    },
  };
}

export async function loadSession(db: Queryable, token: string): Promise<BrowserSession | null> {
  const result = await db.query<{
    id:         string;
    user_id:    string;
    org_id:     string;
    org_label:  string | null;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT id, user_id, org_id, org_label, created_at, expires_at FROM browser_sync_sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256Hex(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id:        row.id,
    userId:    row.user_id,
    orgId:     row.org_id,
    orgLabel:  row.org_label,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function revokeSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('UPDATE browser_sync_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}
