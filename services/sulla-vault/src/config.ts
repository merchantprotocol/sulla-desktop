import { randomBytes } from 'node:crypto';

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
}

function jsonEnvironment(name: string): unknown | undefined {
  const value = process.env[name];
  return value ? JSON.parse(value) : undefined;
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
  };
}
