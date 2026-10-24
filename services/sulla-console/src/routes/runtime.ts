// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { Router } from 'express';

import { envelope } from '../envelope.js';
import {
  type RouteContext,
  type ServiceName,
  forwardedQuery,
  httpError,
  param,
  proxySuffix,
  requestedOrg,
  route,
  serviceJson,
} from './helpers.js';

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

/** Cloud runtime resources, and the server service and path each one maps to. */
const RESOURCES: Record<string, { service: ServiceName; path: string }> = {
  workflows: { service: 'workflows', path: '/v1/workflows' },
  'workflow-runs': { service: 'workflows', path: '/v1/runs' },
  agents: { service: 'agents', path: '/v1/agents' },
  runs: { service: 'agents', path: '/v1/runs' },
};

export function registerRuntimeRoutes(router: Router, { clients }: RouteContext): void {
  router.use('/cloud-runtime/v1', route(async(request, response) => {
    if (!METHODS.has(request.method)) throw httpError(405, 'method_not_allowed');
    const segments = proxySuffix(request);
    const name = segments[0];
    const target = name && Object.hasOwn(RESOURCES, name) ? RESOURCES[name] : undefined;
    if (!target) throw httpError(404, 'not_found');
    const org = requestedOrg(request);
    const rest = segments.slice(1).map(segment => `/${segment}`).join('');
    const path = `${target.path}${rest}${forwardedQuery(request)}`;
    response.json(envelope(org, await serviceJson(request, clients, target.service, org, path)));
  }));

  router.post('/routines/:routineId/execute', route(async(request, response) => {
    const org = requestedOrg(request);
    const body = { message: request.body?.message, workflowId: param(request, 'routineId') };
    const result = await serviceJson(request, clients, 'workflows', org, '/v1/runs', 'POST', body);
    response.status(201).json(result);
  }));
}
