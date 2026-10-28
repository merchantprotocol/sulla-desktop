// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { deriveCapabilitySigningKey } from './auth.js';

import type { FilesKeyring } from './keyring.js';
import type { LegacyPreflightStatus } from './legacyPreflight.js';

export interface Config {
  keyring?: FilesKeyring;
  legacyPreflight?: LegacyPreflightStatus;
  port:                 number;
  databaseUrl:          string;
  vaultDatabaseUrl?:    string;
  vaultAuthorityUrl?:    string;
  vaultAuthorityId?:     string;
  vaultAuthorityToken?:  string;
  vaultAuthorityCaPath?: string;
  vaultBrokerUrl?:       string;
  vaultBrokerServiceId?: string;
  vaultBrokerServiceToken?: string;
  vaultBrokerCaPath?:    string;
  chunkRoot:            string;
  dataRoot:             string;
  filesRoot?:           string;
  caseInsensitiveRoot:  boolean;
  backupTarget?:        string;
  capabilitySigningKey: string | Buffer;
  serverJwtSecret?:     string;
  accounts?: {
    url:          string;
    serviceToken: string;
    audience:     string;
  };
  localToken?:          string;
  bootstrapServiceId?:  string;
  bootstrapToken?:      string;
  tlsCertificatePath?:  string;
  tlsPrivateKeyPath?:   string;
  serverMasterKey?:     string;
  mode:                 'desktop' | 'server';
  deviceId:             string;
  userId:               string;
  orgId?:               string;
  serverUrl?:           string;
  cloudUrl:             string;
  paused:               boolean;
  modelDir:             string;
  fileRoots?:           FileRootConfig[];
  fuseExperiment?:      boolean;
}

export interface FileRootConfig {
  id: string;
  name: string;
  path: string;
  syncMode: 'local' | 'server';
  paused: boolean;
  exclusions: string[];
  primary: boolean;
}

function fileRoots(filesRoot:string | undefined):FileRootConfig[] {
  if (!filesRoot) return [];
  const fallback:FileRootConfig = { id: 'default', name: 'Sulla Files', path: filesRoot, syncMode: 'server', paused: false, exclusions: [], primary: true };
  const raw = process.env.SULLA_FILES_ROOTS_JSON;
  if (!raw) return [fallback];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('root configuration must be an array');
    const roots = parsed.map((item:any):FileRootConfig => ({
      id:         String(item.id ?? ''),
      name:       String(item.name ?? ''),
      path:       resolve(String(item.path ?? '')),
      syncMode:   item.syncMode === 'server' ? 'server' : 'local',
      paused:     item.paused === true,
      exclusions: Array.isArray(item.exclusions) ? item.exclusions.filter((value:unknown):value is string => typeof value === 'string') : [],
      primary:    item.id === 'default',
    }));
    if (!roots.some(root => root.id === 'default')) roots.unshift(fallback);
    if (roots.some(root => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(root.id) || !root.name || !root.path)) throw new Error('root configuration contains invalid fields');
    if (new Set(roots.map(root => root.id)).size !== roots.length || new Set(roots.map(root => root.path)).size !== roots.length) throw new Error('root configuration contains duplicates');
    for (const [index, root] of roots.entries()) {
      for (const other of roots.slice(index + 1)) {
        const prefix = (value:string) => value.endsWith('/') ? value : `${ value }/`;
        if (root.path === other.path || root.path.startsWith(prefix(other.path)) || other.path.startsWith(prefix(root.path))) throw new Error('root configuration paths overlap');
      }
    }
    return roots;
  } catch (error) {
    throw new Error(`SULLA_FILES_ROOTS_JSON is invalid: ${ error instanceof Error ? error.message : String(error) }`);
  }
}
export function loadConfig():Config {
  const databaseUrl = process.env.SULLA_FILES_DATABASE_URL;
  if (!databaseUrl) throw new Error('SULLA_FILES_DATABASE_URL is required');
  const installationSecret = process.env.SULLA_API_TOKEN ?? '';
  const capabilitySigningKey = process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY ||
    process.env.SULLA_FILES_INTERNAL_TOKEN ||
    (installationSecret ? deriveCapabilitySigningKey(installationSecret) : '');
  if (Buffer.byteLength(capabilitySigningKey) < 32) throw new Error('SULLA_FILES_CAPABILITY_SIGNING_KEY or SULLA_API_TOKEN is required');
  const mode = process.env.SULLA_FILES_MODE === 'server' ? 'server' : 'desktop';
  const accountsUrl = process.env.SULLA_FILES_ACCOUNTS_URL?.trim();
  const accountsTokenFile = process.env.SULLA_FILES_ACCOUNTS_SERVICE_TOKEN_FILE?.trim();
  if (Boolean(accountsUrl) !== Boolean(accountsTokenFile)) throw new Error('Files Accounts URL and service token file must be configured together');
  let accounts:Config['accounts'];
  if (accountsUrl && accountsTokenFile) {
    const url = new URL(accountsUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('SULLA_FILES_ACCOUNTS_URL must be an HTTP(S) origin');
    }
    const stat = statSync(accountsTokenFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('SULLA_FILES_ACCOUNTS_SERVICE_TOKEN_FILE must be private');
    const serviceToken = readFileSync(accountsTokenFile, 'utf8').trim();
    if (Buffer.byteLength(serviceToken) < 32) throw new Error('SULLA_FILES_ACCOUNTS_SERVICE_TOKEN_FILE must contain at least 32 bytes');
    accounts = { url: url.origin, serviceToken, audience: process.env.SULLA_FILES_ACCOUNTS_AUDIENCE?.trim() || 'sulla-files' };
    if (accounts.audience !== 'sulla-files') throw new Error('SULLA_FILES_ACCOUNTS_AUDIENCE must be sulla-files');
  }

  const filesRoot = mode === 'desktop' && process.env.SULLA_FILES_STORED_ONLY !== '1'
    ? resolve(process.env.SULLA_FILES_FOLDER ?? '/data/files')
    : undefined;
  return {
    port:             Number(process.env.SULLA_FILES_PORT ?? 8792),
    databaseUrl,
    vaultDatabaseUrl:    process.env.SULLA_FILES_VAULT_DATABASE_URL,
    vaultAuthorityUrl:   process.env.SULLA_FILES_VAULT_AUTHORITY_URL,
    vaultAuthorityId:    process.env.SULLA_FILES_VAULT_AUTHORITY_SERVICE_ID,
    vaultAuthorityToken: process.env.SULLA_FILES_VAULT_AUTHORITY_TOKEN,
    vaultAuthorityCaPath: process.env.SULLA_FILES_VAULT_AUTHORITY_CA_PATH,
    vaultBrokerUrl:       process.env.SULLA_FILES_VAULT_BROKER_URL,
    vaultBrokerServiceId: process.env.SULLA_FILES_VAULT_BROKER_SERVICE_ID,
    vaultBrokerServiceToken: process.env.SULLA_FILES_VAULT_BROKER_TOKEN,
    vaultBrokerCaPath:    process.env.SULLA_FILES_VAULT_BROKER_CA_PATH,
    chunkRoot:        resolve(process.env.SULLA_FILES_CHUNK_ROOT ?? '/var/lib/sulla-files/chunks'),
    dataRoot:         resolve(process.env.SULLA_FILES_DATA_ROOT ?? '/var/lib/sulla-files'),
    filesRoot,
    caseInsensitiveRoot: process.env.SULLA_FILES_CASE_INSENSITIVE_ROOT === '1',
    backupTarget:     process.env.SULLA_FILES_BACKUP_TARGET ? resolve(process.env.SULLA_FILES_BACKUP_TARGET) : undefined,
    capabilitySigningKey,
    serverJwtSecret:  process.env.SULLA_FILES_JWT_SECRET,
    accounts,
    localToken:       process.env.SULLA_FILES_LOCAL_TOKEN,
    bootstrapServiceId: process.env.SULLA_FILES_BOOTSTRAP_SERVICE_ID ?? 'sulla-desktop-files-bootstrap',
    bootstrapToken:     process.env.SULLA_FILES_BOOTSTRAP_TOKEN,
    tlsCertificatePath: process.env.SULLA_FILES_TLS_CERTIFICATE_PATH,
    tlsPrivateKeyPath:  process.env.SULLA_FILES_TLS_PRIVATE_KEY_PATH,
    serverMasterKey:    process.env.SULLA_FILES_MASTER_KEY,
    mode,
    deviceId:         process.env.SULLA_FILES_DEVICE_ID ?? 'desktop',
    userId:           process.env.SULLA_FILES_USER_ID ?? 'desktop-user',
    orgId:            process.env.SULLA_FILES_ORG_ID,
    serverUrl:        process.env.SULLA_FILES_SERVER_URL,
    cloudUrl:         (process.env.SULLA_CLOUD_API_URL ?? 'https://sulla-workers.merchantprotocol.workers.dev').replace(/\/+$/, ''),
    paused:           process.env.SULLA_FILES_PAUSED === '1',
    modelDir:         resolve(process.env.SULLA_FILES_EMBEDDING_MODEL_DIR ?? '/app/models/potion-retrieval-32M'),
    fileRoots:        mode === 'desktop' ? fileRoots(filesRoot) : [],
    fuseExperiment:   process.env.SULLA_FILES_FUSE_EXPERIMENT === '1',
  };
}
