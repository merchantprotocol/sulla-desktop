import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export type VaultMode = 'desktop' | 'server';

export interface VaultConfig {
  mode:                        VaultMode;
  port:                        number;
  databaseUrl:                 string;
  adminDatabaseUrl?:           string;
  jwtSecret:                   string;
  desktopLoginHash?:           string;
  desktopPublicKey?:           string;
  desktopEncryptedPrivateKey?: unknown;
  desktopEncryptedUserKey?:    unknown;
  desktopKdf?:                 unknown;
  extensionOrigins:            string[];
  brokerServiceId?:            string;
  brokerServiceToken?:         string;
  filesServiceId?:             string;
  filesServiceToken?:          string;
  bootstrapServiceId?:         string;
  bootstrapServiceToken?:      string;
  approvalServiceId?:          string;
  approvalServiceToken?:       string;
  controlServiceId?:           string;
  controlServiceToken?:        string;
  serverBootstrapToken?:       string;
  humanUiOrigin?:               string;
  legacyDatabaseUrl?:           string;
  tlsCertificatePath?:          string;
  tlsPrivateKeyPath?:           string;
  accounts?: {
    url:           string;
    serviceId:     string;
    serviceToken:  string;
    audience:      string;
    requiredRoles: string[];
  };
}

function jsonEnvironment(name: string): unknown | undefined {
  const value = process.env[name];
  return value ? JSON.parse(value) : undefined;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${ name } is required when Accounts integration is configured`);
  return value;
}

function secretFile(name: string): string {
  const path = requiredEnvironment(name);
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${ name } must name a regular file inaccessible to group and other users`);
  }
  const value = readFileSync(path, 'utf8').trim();
  if (Buffer.byteLength(value) < 32) throw new Error(`${ name } must contain at least 32 bytes`);
  return value;
}

function accountsBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SULLA_VAULT_ACCOUNTS_URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function loadConfig(): VaultConfig {
  const mode = process.env.SULLA_VAULT_MODE ?? 'desktop';
  if (mode !== 'desktop' && mode !== 'server') {
    throw new Error('SULLA_VAULT_MODE must be desktop or server');
  }
  const databaseUrl = process.env.SULLA_VAULT_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('SULLA_VAULT_DATABASE_URL is required');
  }
  const jwtSecret = process.env.SULLA_VAULT_JWT_SECRET ?? (mode === 'desktop' ? randomBytes(48).toString('base64url') : '');
  if (jwtSecret.length < 32) {
    throw new Error('SULLA_VAULT_JWT_SECRET must contain at least 32 characters in server mode');
  }
  const accountsNames = [
    'SULLA_VAULT_ACCOUNTS_URL',
    'SULLA_VAULT_ACCOUNTS_SERVICE_ID',
    'SULLA_VAULT_ACCOUNTS_SERVICE_TOKEN_FILE',
    'SULLA_VAULT_ACCOUNTS_AUDIENCE',
    'SULLA_VAULT_ACCOUNTS_REQUIRED_ROLES',
  ];
  const accountsConfigured = accountsNames.some(name => Boolean(process.env[name]?.trim()));
  if (accountsConfigured && mode !== 'server') {
    throw new Error('Accounts integration is available only in server mode');
  }
  const configuredAudience = process.env.SULLA_VAULT_ACCOUNTS_AUDIENCE?.trim() || 'sulla-vault';
  if (accountsConfigured && configuredAudience !== 'sulla-vault') {
    throw new Error('SULLA_VAULT_ACCOUNTS_AUDIENCE must be sulla-vault');
  }
  const requiredRoles = (process.env.SULLA_VAULT_ACCOUNTS_REQUIRED_ROLES ?? 'member')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (accountsConfigured && requiredRoles.length === 0) {
    throw new Error('SULLA_VAULT_ACCOUNTS_REQUIRED_ROLES must contain at least one role');
  }
  const accounts = accountsConfigured ? {
    url:           accountsBaseUrl(requiredEnvironment('SULLA_VAULT_ACCOUNTS_URL')),
    serviceId:     requiredEnvironment('SULLA_VAULT_ACCOUNTS_SERVICE_ID'),
    serviceToken:  secretFile('SULLA_VAULT_ACCOUNTS_SERVICE_TOKEN_FILE'),
    audience:      configuredAudience,
    requiredRoles,
  } : undefined;
  return {
    mode,
    port:                       Number(process.env.SULLA_VAULT_PORT ?? 8787),
    databaseUrl,
    adminDatabaseUrl:           process.env.SULLA_VAULT_ADMIN_DATABASE_URL,
    jwtSecret,
    desktopLoginHash:           process.env.SULLA_VAULT_DESKTOP_LOGIN_HASH,
    desktopPublicKey:           process.env.SULLA_VAULT_DESKTOP_PUBLIC_KEY,
    desktopEncryptedPrivateKey: jsonEnvironment('SULLA_VAULT_DESKTOP_ENCRYPTED_PRIVATE_KEY'),
    desktopEncryptedUserKey:    jsonEnvironment('SULLA_VAULT_DESKTOP_ENCRYPTED_USER_KEY'),
    desktopKdf:                 jsonEnvironment('SULLA_VAULT_DESKTOP_KDF'),
    extensionOrigins:           (process.env.SULLA_VAULT_EXTENSION_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
    brokerServiceId:            process.env.SULLA_VAULT_BROKER_SERVICE_ID ?? 'sulla-tools',
    brokerServiceToken:         process.env.SULLA_VAULT_BROKER_TOKEN,
    filesServiceId:             process.env.SULLA_VAULT_FILES_SERVICE_ID ?? 'sulla-files',
    filesServiceToken:          process.env.SULLA_VAULT_FILES_TOKEN,
    bootstrapServiceId:         process.env.SULLA_VAULT_BOOTSTRAP_SERVICE_ID ?? 'sulla-desktop-bootstrap',
    bootstrapServiceToken:      process.env.SULLA_VAULT_BOOTSTRAP_TOKEN,
    approvalServiceId:          process.env.SULLA_VAULT_APPROVAL_SERVICE_ID ?? 'sulla-desktop-approval',
    approvalServiceToken:       process.env.SULLA_VAULT_APPROVAL_TOKEN,
    controlServiceId:           process.env.SULLA_VAULT_DESKTOP_CONTROL_SERVICE_ID ?? 'sulla-desktop-control',
    controlServiceToken:        process.env.SULLA_VAULT_DESKTOP_CONTROL_TOKEN,
    serverBootstrapToken:       process.env.SULLA_VAULT_SERVER_BOOTSTRAP_TOKEN,
    humanUiOrigin:              process.env.SULLA_VAULT_HUMAN_UI_ORIGIN ?? `https://127.0.0.1:${ process.env.SULLA_VAULT_PUBLISHED_PORT ?? '30135' }`,
    legacyDatabaseUrl:          process.env.SULLA_VAULT_LEGACY_DATABASE_URL,
    tlsCertificatePath:         process.env.SULLA_VAULT_TLS_CERTIFICATE_PATH,
    tlsPrivateKeyPath:          process.env.SULLA_VAULT_TLS_PRIVATE_KEY_PATH,
    accounts,
  };
}
