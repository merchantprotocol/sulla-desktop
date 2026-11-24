// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CLERK_DEADLINE_MS, CLERK_ENVIRONMENTS, clerkEndpoints } from '../../integrations/clerk/ClerkEndpoints';

import type { InputSchemaDef, ToolOperation } from '../base';
import type { ToolManifest } from '../registry';

const environment = { type: 'enum' as const, enum: [...CLERK_ENVIRONMENTS], optional: true, default: 'staging', description: 'Clerk instance to target. Defaults to staging.' };
// BaseTool's boolean parser coerces strings. Keep this as raw input so only a
// real boolean true reaches the mandatory vault-layer confirmation check.
const confirm = { type: 'any' as const, optional: true, description: 'Must be the JSON boolean true (not a string) to confirm a destructive action.' };
const loader = () => import('./ClerkWorker');

function manifest(name: string, description: string, schemaDef: InputSchemaDef, operation: ToolOperation, destructive = false): ToolManifest {
  return {
    name:            `clerk_${ name }`,
    category:        'clerk',
    description,
    schemaDef:       {
      ...schemaDef,
      environment,
      ...(name !== 'get_config' ? { operationId: { type: 'string', optional: true, description: 'Retry this exact operation after its Decide approval is complete.' } } : {}),
      ...(destructive ? { confirm } : {}),
    },
    operationTypes:  [operation],
    executionTarget: 'desktop-local',
    placements:      ['desktop'],
    relayable:       false,
    credential:      { integration: 'clerk' },
    sideEffect:      destructive ? 'irreversible' : operation === 'read' ? 'read' : 'write',
    deadlineMs:      CLERK_DEADLINE_MS,
    loader,
  };
}

export const clerkToolManifests: ToolManifest[] = [
  manifest('get_config', 'Read the Clerk publishable keys, connection state and instance IDs. Never returns secret keys.', {}, 'read'),
  manifest('raw_request', 'Send a raw JSON request to the fixed Clerk Backend API. Destructive actions require explicit confirmation and, in production, Desktop Decide approval.', {
    path:      { type: 'string', description: 'Relative Backend API path, e.g. /users. Put query parameters in query; no hostname.' },
    method:    { type: 'enum', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET', optional: true },
    query:     { type: 'object', optional: true, description: 'Clerk URL query parameters; arrays become repeated parameters.' },
    body:      { type: 'object', optional: true, description: 'Clerk JSON body when the endpoint accepts one.' },
    accountId: { type: 'string', optional: true, description: 'The Clerk account is always default.' },
    headers:   { type: 'object', optional: true, description: 'Caller-supplied headers are not supported.' },
  }, 'execute', true),
  ...Object.entries(clerkEndpoints).map(([name, endpoint]) => {
    const parameters: InputSchemaDef = Object.fromEntries(
      [...endpoint.path.matchAll(/\{([a-z_]+)\}/g)].map(match => [match[1], { type: 'string', description: `Clerk ${ match[1] }.` }]),
    );
    if (endpoint.method === 'GET') {
      parameters.filters = { type: 'object', optional: true, description: 'Documented Clerk query filters (for example query, user_id, status, or order_by).' };
    }
    if (endpoint.paged) {
      parameters.limit = { type: 'number', optional: true, default: 50, description: 'Page size, 1–500.' };
      parameters.offset = { type: 'number', optional: true, default: 0, description: 'Start at 0, then pass next_offset until it is null.' };
    }
    if (name === 'list_users') parameters.starting_after = { type: 'string', optional: true, description: 'Use next_cursor to page in created_at order. Do not combine with a nonzero offset.' };
    if (endpoint.body || endpoint.optionalBody) {
      parameters.body = { type: 'object', optional: !endpoint.body, description: 'Documented Clerk JSON body fields.' };
      if (name === 'revoke_session') {
        parameters.body.properties = { reset_client_trust: { type: 'boolean', optional: true, description: 'Reset client trust while revoking this session.' } };
      } else if (name === 'revoke_organization_invitation') {
        parameters.body.properties = { requesting_user_id: { type: 'string', optional: true, description: 'Clerk user ID performing the revocation.' } };
      }
    }
    const destructive = endpoint.method === 'DELETE' || endpoint.path.endsWith('/revoke');
    const operation = endpoint.method === 'GET' ? 'read' : destructive ? 'delete' : endpoint.method === 'PATCH' ? 'update' : 'execute';
    return manifest(name, endpoint.description, parameters, operation, destructive);
  }),
];
