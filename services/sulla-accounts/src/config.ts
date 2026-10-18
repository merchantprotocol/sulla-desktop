import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';

export type AccountsMode = 'desktop' | 'server';

export interface ServiceGrant {
  token: Buffer;
  issuers: Set<string>;
  allowedAudiences: Set<string>;
  pathPrefixes: string[];
  methods: Set<string>;
}

export interface AccountsConfig {
  mode: AccountsMode;
  port: number;
  databaseUrl: string;
  publicUrl: string;
  allowedReturnOrigins: Set<string>;
  bootstrapSecret?: Buffer;
  sessionSecret: Buffer;
  encryptionKey: Buffer;
  adminSecret?: Buffer;
  serviceTokens: Map<string, ServiceGrant>;
  keycloakIssuer?: string;
  keycloakNativeClientId?: string;
  keycloakWebClientId?: string;
  keycloakMembershipAudience?: string;
  keycloakResourceAudiences: Set<string>;
  trustedProxy: boolean;
}

async function readSecretFile(variable: string, exactBytes?: number, preserveRaw = false): Promise<Buffer> {
  const path = process.env[variable];
  if (!path) throw new Error(`${variable} is required`);
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`${variable} must name a regular file inaccessible to group and other users`);
  }
  const raw = await readFile(path);
  let value: Buffer;
  if (preserveRaw || exactBytes === 32 && raw.length === 32) {
    value = raw;
  } else if (exactBytes === 32 && /^[0-9a-fA-F]{64}\s*$/.test(raw.toString('ascii'))) {
    value = Buffer.from(raw.toString('ascii').trim(), 'hex');
  } else {
    value = Buffer.from(raw.toString('utf8').trim(), 'utf8');
  }
  if (exactBytes !== undefined ? value.length !== exactBytes : value.length < 32) {
    throw new Error(`${variable} has an invalid length`);
  }
  return value;
}

async function readTextFile(variable: string): Promise<string> {
  const path = process.env[variable];
  if (!path) throw new Error(`${variable} is required`);
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`${variable} must name a regular file inaccessible to group and other users`);
  }
  const value = (await readFile(path, 'utf8')).trim();
  if (!value) throw new Error(`${variable} must not be empty`);
  return value;
}

export function normalizeIssuer(input: string): string {
  if (!input || input.trim() !== input) throw new Error('issuer is invalid');
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash) throw new Error('issuer must not contain credentials, query, or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || isIP(url.hostname) === 4 && url.hostname.startsWith('127.')))) {
    throw new Error('issuer must use HTTPS (loopback HTTP is permitted)');
  }
  // Issuers are security identifiers, not merely locations. Preserve the exact
  // configured spelling so discovery and token `iss` comparisons stay exact.
  return input;
}

export function assertTrustedUrl(input: string, issuer: string): string {
  const value = new URL(input);
  const trusted = new URL(issuer);
  if (value.username || value.password || value.hash || value.origin !== trusted.origin) {
    throw new Error('OIDC endpoint must share the explicitly trusted issuer origin');
  }
  if (value.protocol !== 'https:' && !(value.protocol === 'http:' && (value.hostname === 'localhost' || value.hostname.startsWith('127.')))) {
    throw new Error('OIDC endpoint must use HTTPS');
  }
  return value.href;
}

export async function loadConfig(): Promise<AccountsConfig> {
  const mode = process.env.SULLA_ACCOUNTS_MODE ?? 'desktop';
  if (mode !== 'desktop' && mode !== 'server') throw new Error('SULLA_ACCOUNTS_MODE must be desktop or server');
  const databaseUrl = await readTextFile('SULLA_ACCOUNTS_DATABASE_URL_FILE');
  const publicUrl = normalizeIssuer(process.env.SULLA_ACCOUNTS_PUBLIC_URL ?? 'https://127.0.0.1:3020');
  const keycloakIssuer = process.env.SULLA_ACCOUNTS_KEYCLOAK_ISSUER ? normalizeIssuer(process.env.SULLA_ACCOUNTS_KEYCLOAK_ISSUER) : undefined;
  const keycloakNativeClientId = process.env.SULLA_ACCOUNTS_KEYCLOAK_NATIVE_CLIENT_ID;
  const keycloakWebClientId = process.env.SULLA_ACCOUNTS_KEYCLOAK_WEB_CLIENT_ID;
  const keycloakMembershipAudience = process.env.SULLA_ACCOUNTS_KEYCLOAK_MEMBERSHIP_AUDIENCE;
  const keycloakResourceAudiences = new Set((process.env.SULLA_ACCOUNTS_KEYCLOAK_RESOURCE_AUDIENCES ?? '').split(',').map(value => value.trim()).filter(Boolean));
  if (mode === 'server' && (!keycloakIssuer || !keycloakNativeClientId || !keycloakWebClientId || !keycloakMembershipAudience || !keycloakResourceAudiences.size)) {
    throw new Error('server mode requires Keycloak issuer, native/web clients, membership audience, and resource audiences');
  }

  const serviceTokens = new Map<string, ServiceGrant>();
  const serviceTokenFile = process.env.SULLA_ACCOUNTS_SERVICE_TOKENS_FILE;
  if (serviceTokenFile) {
    const raw = await readSecretFile('SULLA_ACCOUNTS_SERVICE_TOKENS_FILE');
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, { token?: unknown; issuers?: unknown; allowedAudiences?: unknown; pathPrefixes?: unknown; methods?: unknown }>;
    for (const [name, grant] of Object.entries(parsed)) {
      if (!name || typeof grant?.token !== 'string' || Buffer.byteLength(grant.token) < 32 || !Array.isArray(grant.issuers) || !Array.isArray(grant.allowedAudiences) || !Array.isArray(grant.pathPrefixes)) {
        throw new Error('service token file contains an invalid entry');
      }
      const issuers = new Set(grant.issuers.map(value => normalizeIssuer(String(value))));
      const allowedAudiences = new Set(grant.allowedAudiences.map(value => String(value)));
      const pathPrefixes = grant.pathPrefixes.map(value => String(value));
      const configuredMethods = grant.methods ?? ['GET', 'POST'];
      if (!Array.isArray(configuredMethods)) throw new Error('service token grant methods must be an array');
      const methods = new Set(configuredMethods.map(value => String(value).toUpperCase()));
      if (!issuers.size || !allowedAudiences.size || [...allowedAudiences].some(value => !value || value.length > 300) || !pathPrefixes.length || pathPrefixes.some(prefix => !prefix.startsWith('/') || prefix.startsWith('//'))) {
        throw new Error('service token grant must contain trusted issuers, audiences, and absolute path prefixes');
      }
      if (!methods.size || [...methods].some(method => !['GET', 'POST'].includes(method))) {
        throw new Error('service token grant methods must contain only GET and POST');
      }
      serviceTokens.set(name, { token: Buffer.from(grant.token), issuers, allowedAudiences, pathPrefixes, methods });
    }
  }

  return {
    mode,
    port: Number(process.env.SULLA_ACCOUNTS_PORT ?? 3020),
    databaseUrl,
    publicUrl,
    allowedReturnOrigins: new Set((process.env.SULLA_ACCOUNTS_ALLOWED_RETURN_ORIGINS ?? '').split(',').map(v => v.trim()).filter(Boolean)),
    bootstrapSecret: mode === 'desktop' ? await readSecretFile('SULLA_ACCOUNTS_BOOTSTRAP_SECRET_FILE') : undefined,
    sessionSecret: await readSecretFile('SULLA_ACCOUNTS_SESSION_SECRET_FILE', undefined, true),
    encryptionKey: await readSecretFile('SULLA_ACCOUNTS_ENCRYPTION_KEY_FILE', 32),
    adminSecret: mode === 'server' ? await readSecretFile('SULLA_ACCOUNTS_ADMIN_SECRET_FILE') : undefined,
    serviceTokens,
    keycloakIssuer,
    keycloakNativeClientId,
    keycloakWebClientId,
    keycloakMembershipAudience,
    keycloakResourceAudiences,
    trustedProxy: process.env.SULLA_ACCOUNTS_TRUSTED_PROXY === '1',
  };
}
