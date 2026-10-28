// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Settings for the server-mode vault origin (vault.<host>) and the
// server-providers broker. Read from the environment once, so config.ts stays
// untouched. Everything is fail-closed: with no public host configured the
// browser routes answer 404 and no cookie is ever issued.

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BrowserSyncConfig {
  /** Hostname the vault page is served on, e.g. `vault.server.example.com`. Empty disables the browser origin. */
  vaultHost:            string;
  /** `https://vault.<host>`: the only Origin a cookie request may come from. */
  vaultOrigin:          string;
  /** Console URL the vault page links back to, e.g. `https://server.example.com/console/`. */
  dashboardOrigin:      string;
  /** Directory holding WP-A's generated vault-origin build. */
  distDirectory:        string;
  /** Agents service identity allowed to fetch sealed provider credentials. */
  providersServiceId:   string;
  providersServiceToken?: string;
  /** X25519 public key (base64url) of the Agents broker; provider keys are sealed to it. */
  providersRecipientKey?: string;
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

function optionalSecretFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const path = env[name]?.trim();
  if (!path) return undefined;
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${ name } must name a regular file inaccessible to group and other users`);
  }
  const value = readFileSync(path, 'utf8').trim();
  if (Buffer.byteLength(value) < 32) throw new Error(`${ name } must contain at least 32 bytes`);
  return value;
}

function publicUrl(env: NodeJS.ProcessEnv): URL | null {
  const raw = env.SULLA_PUBLIC_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('SULLA_PUBLIC_URL must be an http(s) URL');
  return url;
}

export function loadBrowserSyncConfig(env: NodeJS.ProcessEnv = process.env): BrowserSyncConfig {
  const base = publicUrl(env);
  const explicitHost = env.SULLA_VAULT_BROWSER_HOST?.trim().toLowerCase() ?? '';
  const vaultHost = explicitHost || (base ? `vault.${ base.hostname.toLowerCase() }` : '');
  if (vaultHost && !HOSTNAME.test(vaultHost)) throw new Error('SULLA_VAULT_BROWSER_HOST must be a hostname');
  const port = base?.port ? `:${ base.port }` : '';
  const scheme = base?.protocol === 'http:' ? 'http:' : 'https:';
  const explicitOrigin = env.SULLA_VAULT_BROWSER_ORIGIN?.trim();
  const derivedOrigin = vaultHost ? `${ scheme }//${ vaultHost }${ port }` : '';
  const vaultOrigin = explicitOrigin ? new URL(explicitOrigin).origin : derivedOrigin;
  if (explicitOrigin && new URL(vaultOrigin).hostname !== vaultHost) {
    throw new Error('SULLA_VAULT_BROWSER_ORIGIN must use the vault hostname');
  }
  const dashboardOrigin = env.SULLA_VAULT_DASHBOARD_URL?.trim() || (base ? new URL('/console/', base).href : '');
  const here = dirname(fileURLToPath(import.meta.url));
  const recipient = env.SULLA_VAULT_PROVIDERS_RECIPIENT_PUBLIC_KEY?.trim();
  if (recipient && !PUBLIC_KEY.test(recipient)) {
    throw new Error('SULLA_VAULT_PROVIDERS_RECIPIENT_PUBLIC_KEY must be a base64url X25519 public key');
  }
  return {
    vaultHost,
    vaultOrigin,
    dashboardOrigin,
    distDirectory:         env.SULLA_VAULT_BROWSER_DIST?.trim() || resolve(here, '../../browser-dist'),
    providersServiceId:    env.SULLA_VAULT_PROVIDERS_SERVICE_ID?.trim() || 'sulla-agents',
    providersServiceToken: optionalSecretFile(env, 'SULLA_VAULT_PROVIDERS_SERVICE_TOKEN_FILE'),
    providersRecipientKey: recipient || undefined,
  };
}
