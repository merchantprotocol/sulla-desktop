import fs from 'node:fs';

import { deriveCapabilitySigningKey } from '../../../pkg/rancher-desktop/runtime/capabilityToken.js';

const installationSecret = process.env.SULLA_API_TOKEN ?? '';

export type WorkflowMode = 'desktop' | 'server';

function required(name: string, value: string | undefined): string {
  const result = value?.trim() ?? '';
  if (!result) throw new Error(`${ name } is required`);
  return result;
}

function secretFile(name: string): string {
  const file = required(name, process.env[name]);
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${ name } must name a regular file inaccessible to group and other users`);
  }
  const value = fs.readFileSync(file, 'utf8').trim();
  if (Buffer.byteLength(value) < 32) throw new Error(`${ name } must contain at least 32 bytes`);
  return value;
}

const mode = (process.env.SULLA_WORKFLOW_MODE ?? 'desktop') as WorkflowMode;
if (mode !== 'desktop' && mode !== 'server') throw new Error('SULLA_WORKFLOW_MODE must be desktop or server');

const localToken = mode === 'desktop' ? required('SULLA_API_TOKEN', installationSecret) : '';
if (localToken && Buffer.byteLength(localToken) < 32) throw new Error('SULLA_API_TOKEN must contain at least 32 bytes');

const accountsUrl = mode === 'server' ? required('SULLA_ACCOUNTS_URL', process.env.SULLA_ACCOUNTS_URL) : '';
const accountsServiceId = mode === 'server' ? required('SULLA_ACCOUNTS_SERVICE_ID', process.env.SULLA_ACCOUNTS_SERVICE_ID) : '';
const accountsServiceToken = mode === 'server' ? secretFile('SULLA_ACCOUNTS_SERVICE_TOKEN_FILE') : '';
const audience = mode === 'server' ? required('SULLA_WORKFLOW_AUDIENCE', process.env.SULLA_WORKFLOW_AUDIENCE) : '';
const allowedRunnerScopes = new Set((process.env.SULLA_WORKFLOW_ALLOWED_RUNNER_SCOPES ?? '').split(',').map(value => value.trim()).filter(Boolean));
if (mode === 'server' && !allowedRunnerScopes.size) throw new Error('SULLA_WORKFLOW_ALLOWED_RUNNER_SCOPES is required in server mode');

export const config = {
  mode,
  port:                 Number(process.env.SULLA_WORKFLOW_PORT ?? 8788),
  databaseUrl:          process.env.SULLA_DATABASE_URL ?? 'postgresql://sulla:sulla_dev_password@postgres:5432/sulla',
  redisUrl:             process.env.SULLA_REDIS_URL ?? 'redis://redis:6379',
  managerUrl:           process.env.SULLA_MANAGER_URL ?? 'http://sulla_workflow_manager:8788',
  toolApiUrl:           process.env.SULLA_TOOL_API_URL ?? 'http://host.docker.internal:3000',
  toolApiToken:         process.env.SULLA_API_TOKEN ?? '',
  capabilitySigningKey: process.env.SULLA_CAPABILITY_SIGNING_KEY || (installationSecret ? deriveCapabilitySigningKey(installationSecret) : ''),
  workflowImage:        process.env.SULLA_WORKFLOW_IMAGE ?? 'sulla-workflows:local',
  dockerNetwork:        process.env.SULLA_DOCKER_NETWORK ?? 'sulla_default',
  launcher:             process.env.SULLA_WORKFLOW_LAUNCHER ?? 'docker',
  localToken,
  accountsUrl:          accountsUrl.replace(/\/$/, ''),
  accountsServiceId,
  accountsServiceToken,
  audience,
  requiredRoles:        (process.env.SULLA_WORKFLOW_REQUIRED_ROLES ?? 'member').split(',').map(value => value.trim()).filter(Boolean),
  allowedRunnerScopes,
};
