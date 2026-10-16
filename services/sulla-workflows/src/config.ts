import { deriveCapabilitySigningKey } from '../../../pkg/rancher-desktop/runtime/capabilityToken.js';

const installationSecret = process.env.SULLA_API_TOKEN ?? '';

export const config = {
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
};
