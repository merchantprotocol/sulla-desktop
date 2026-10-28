// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import { readFile, stat } from 'node:fs/promises';

export interface ConsoleConfig {
  port: number;
  databaseUrl: string;
  accountsUrl: URL;
  filesUrl: URL;
  vaultUrl: URL;
  agentsUrl: URL;
  workflowsUrl: URL;
  trustedProxy: boolean;
  publicDirectory?: string;
  accountsAdminSecret?: string;
  licensePublicKey: string;
  licenseStateFile: string;
  cloudUrl: string;
}

async function secretText(name: string): Promise<string> {
  const path = process.env[name];
  if (!path) throw new Error(`${name} is required`);
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`${name} must name a private regular file`);
  const value = (await readFile(path, 'utf8')).trim();
  if (!value) throw new Error(`${name} must not be empty`);
  return value;
}

function serviceUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  const plain = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  if (!plain || url.search || url.hash) throw new Error(`${name} is invalid`);
  return url;
}

export async function loadConfig(): Promise<ConsoleConfig> {
  return {
    port: Number(process.env.SULLA_CONSOLE_PORT ?? 8799),
    databaseUrl: await secretText('SULLA_CONSOLE_DATABASE_URL_FILE'),
    accountsUrl: serviceUrl('SULLA_CONSOLE_ACCOUNTS_URL'),
    filesUrl: serviceUrl('SULLA_CONSOLE_FILES_URL'),
    vaultUrl: serviceUrl('SULLA_CONSOLE_VAULT_URL'),
    agentsUrl: serviceUrl('SULLA_CONSOLE_AGENTS_URL'),
    workflowsUrl: serviceUrl('SULLA_CONSOLE_WORKFLOWS_URL'),
    trustedProxy: process.env.SULLA_CONSOLE_TRUSTED_PROXY === '1',
    publicDirectory: process.env.SULLA_CONSOLE_PUBLIC_DIR ?? '/opt/sulla-console/public',
    accountsAdminSecret: process.env.SULLA_ACCOUNTS_ADMIN_SECRET_FILE
      ? await secretText('SULLA_ACCOUNTS_ADMIN_SECRET_FILE')
      : undefined,
    licensePublicKey: process.env.SULLA_SERVER_LICENSE_PUBLIC_KEY ?? '',
    licenseStateFile: process.env.SULLA_SERVER_LICENSE_STATE_FILE ?? '/var/lib/sulla-console/license.json',
    cloudUrl: process.env.SULLA_CLOUD_API_URL ?? 'https://api.sulladesktop.com',
  };
}
