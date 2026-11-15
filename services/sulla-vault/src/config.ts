// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * The Desktop vault runs only in local desktop mode. Hosted server mode
 * (Accounts-backed identity, org console, bootstrap CLI, browser sync origin)
 * lives in merchantprotocol/sulla-server; this image refuses to start as a server.
 */
export type VaultMode = 'desktop';

export interface VaultConfig {
  mode:                        VaultMode;
  port:                        number;
  databaseUrl:                 string;
  adminDatabaseUrl?:           string;
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
  filesApiUrl?:                string;
  auditSpoolDir?:              string;
  bootstrapServiceId?:         string;
  bootstrapServiceToken?:      string;
  approvalServiceId?:          string;
  approvalServiceToken?:       string;
  controlServiceId?:           string;
  controlServiceToken?:        string;
  humanUiOrigin?:               string;
  legacyDatabaseUrl?:           string;
  tlsCertificatePath?:          string;
  tlsPrivateKeyPath?:           string;
}

function jsonEnvironment(name: string): unknown | undefined {
  const value = process.env[name];
  return value ? JSON.parse(value) : undefined;
}

export function loadConfig(): VaultConfig {
  const mode = process.env.SULLA_VAULT_MODE?.trim() || 'desktop';
  if (mode !== 'desktop') {
    throw new Error('SULLA_VAULT_MODE must be desktop; Sulla Server runs its own vault service');
  }
  const databaseUrl = process.env.SULLA_VAULT_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('SULLA_VAULT_DATABASE_URL is required');
  }
  return {
    mode,
    port:                       Number(process.env.SULLA_VAULT_PORT ?? 8787),
    databaseUrl,
    adminDatabaseUrl:           process.env.SULLA_VAULT_ADMIN_DATABASE_URL,
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
    filesApiUrl:                process.env.SULLA_FILES_API_URL ?? 'https://sulla_files:8792',
    auditSpoolDir:              process.env.SULLA_VAULT_AUDIT_SPOOL_DIR ?? '/var/lib/sulla-vault',
    bootstrapServiceId:         process.env.SULLA_VAULT_BOOTSTRAP_SERVICE_ID ?? 'sulla-desktop-bootstrap',
    bootstrapServiceToken:      process.env.SULLA_VAULT_BOOTSTRAP_TOKEN,
    approvalServiceId:          process.env.SULLA_VAULT_APPROVAL_SERVICE_ID ?? 'sulla-desktop-approval',
    approvalServiceToken:       process.env.SULLA_VAULT_APPROVAL_TOKEN,
    controlServiceId:           process.env.SULLA_VAULT_DESKTOP_CONTROL_SERVICE_ID ?? 'sulla-desktop-control',
    controlServiceToken:        process.env.SULLA_VAULT_DESKTOP_CONTROL_TOKEN,
    humanUiOrigin:              process.env.SULLA_VAULT_HUMAN_UI_ORIGIN ?? `https://127.0.0.1:${ process.env.SULLA_VAULT_PUBLISHED_PORT ?? '30135' }`,
    legacyDatabaseUrl:          process.env.SULLA_VAULT_LEGACY_DATABASE_URL,
    tlsCertificatePath:         process.env.SULLA_VAULT_TLS_CERTIFICATE_PATH,
    tlsPrivateKeyPath:          process.env.SULLA_VAULT_TLS_PRIVATE_KEY_PATH,
  };
}
