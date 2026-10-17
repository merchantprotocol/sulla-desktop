import type { FilesKeyring } from './keyring.js';
import { resolve } from 'node:path';

import { deriveCapabilitySigningKey } from './auth.js';

export interface Config {
  keyring?: FilesKeyring;
  port:                 number;
  databaseUrl:          string;
  vaultDatabaseUrl?:    string;
  chunkRoot:            string;
  dataRoot:             string;
  filesRoot?:           string;
  backupTarget?:        string;
  capabilitySigningKey: string | Buffer;
  serverJwtSecret?:     string;
  localToken?:          string;
  mode:                 'desktop' | 'server';
  deviceId:             string;
  userId:               string;
  orgId?:               string;
  serverUrl?:           string;
  cloudUrl:             string;
  paused:               boolean;
  modelDir:             string;
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

  return {
    port:             Number(process.env.SULLA_FILES_PORT ?? 8792),
    databaseUrl,
    vaultDatabaseUrl: process.env.SULLA_FILES_VAULT_DATABASE_URL,
    chunkRoot:        resolve(process.env.SULLA_FILES_CHUNK_ROOT ?? '/var/lib/sulla-files/chunks'),
    dataRoot:         resolve(process.env.SULLA_FILES_DATA_ROOT ?? '/var/lib/sulla-files'),
    filesRoot:        mode === 'desktop' ? resolve(process.env.SULLA_FILES_FOLDER ?? '/data/files') : undefined,
    backupTarget:     process.env.SULLA_FILES_BACKUP_TARGET ? resolve(process.env.SULLA_FILES_BACKUP_TARGET) : undefined,
    capabilitySigningKey,
    serverJwtSecret:  process.env.SULLA_FILES_JWT_SECRET,
    localToken:       process.env.SULLA_FILES_LOCAL_TOKEN,
    mode,
    deviceId:         process.env.SULLA_FILES_DEVICE_ID ?? 'desktop',
    userId:           process.env.SULLA_FILES_USER_ID ?? 'desktop-user',
    orgId:            process.env.SULLA_FILES_ORG_ID,
    serverUrl:        process.env.SULLA_FILES_SERVER_URL,
    cloudUrl:         (process.env.SULLA_CLOUD_API_URL ?? 'https://sulla-workers.merchantprotocol.workers.dev').replace(/\/+$/, ''),
    paused:           process.env.SULLA_FILES_PAUSED === '1',
    modelDir:         resolve(process.env.SULLA_FILES_EMBEDDING_MODEL_DIR ?? '/app/models/potion-retrieval-32M'),
  };
}
