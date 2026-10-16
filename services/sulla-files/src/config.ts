import { resolve } from 'node:path';

import { deriveCapabilitySigningKey } from '../../../pkg/rancher-desktop/runtime/capabilityToken.js';
export interface Config { port: number; databaseUrl: string; chunkRoot: string; capabilitySigningKey: string | Buffer }
export function loadConfig():Config {
  const databaseUrl = process.env.SULLA_FILES_DATABASE_URL;
  if (!databaseUrl) throw new Error('SULLA_FILES_DATABASE_URL is required');
  const installationSecret = process.env.SULLA_API_TOKEN ?? '';
  const capabilitySigningKey = process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY ||
    process.env.SULLA_FILES_INTERNAL_TOKEN ||
    (installationSecret ? deriveCapabilitySigningKey(installationSecret) : '');
  if (Buffer.byteLength(capabilitySigningKey) < 32) throw new Error('SULLA_FILES_CAPABILITY_SIGNING_KEY or SULLA_API_TOKEN is required');
  return { port: Number(process.env.SULLA_FILES_PORT ?? 8792), databaseUrl, chunkRoot: resolve(process.env.SULLA_FILES_CHUNK_ROOT ?? '/var/lib/sulla-files/chunks'), capabilitySigningKey };
}
