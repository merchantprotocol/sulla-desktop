// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { deriveCapabilitySigningKey } from '../../../packages/runtime-protocol/src/capabilityToken.js';

const installationSecret = process.env.SULLA_API_TOKEN ?? '';

export type WorkflowRole = 'manager' | 'runner';

function required(name: string, value: string | undefined): string {
  const result = value?.trim() ?? '';
  if (!result) throw new Error(`${ name } is required`);
  return result;
}

const role = (process.env.SULLA_WORKFLOW_ROLE ?? 'manager') as WorkflowRole;
if (role !== 'manager' && role !== 'runner') throw new Error('SULLA_WORKFLOW_ROLE must be manager or runner');

const localToken = role === 'manager' ? required('SULLA_API_TOKEN', installationSecret) : '';
if (localToken && Buffer.byteLength(localToken) < 32) throw new Error('SULLA_API_TOKEN must contain at least 32 bytes');


export const config = {
  role,
  port:                 Number(process.env.SULLA_WORKFLOW_PORT ?? 8788),
  databaseUrl:          process.env.SULLA_DATABASE_URL ?? 'postgresql://sulla:sulla_dev_password@postgres:5432/sulla',
  redisUrl:             process.env.SULLA_REDIS_URL ?? 'redis://redis:6379',
  managerUrl:           process.env.SULLA_MANAGER_URL ?? 'http://sulla_workflow_manager:8788',
  toolApiUrl:           process.env.SULLA_TOOL_API_URL ?? 'http://host.docker.internal:3000',
  toolApiToken:         process.env.SULLA_API_TOKEN ?? '',
  capabilitySigningKey: process.env.SULLA_CAPABILITY_SIGNING_KEY || (installationSecret ? deriveCapabilitySigningKey(installationSecret) : ''),
  workflowImage:        process.env.SULLA_WORKFLOW_IMAGE ?? 'sulla-workflows:local',
  dockerNetwork:        process.env.SULLA_DOCKER_NETWORK ?? 'sulla_default',
  // Desktop sets this only after it prepared the shared /mnt/sulla-files anchor.
  filesGuestMount:      process.env.SULLA_FILES_GUEST_MOUNT === '1',
  localToken,
};
