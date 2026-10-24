// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { Router } from 'express';

import {
  type RouteContext,
  forwardedQuery,
  httpError,
  proxySuffix,
  requestedOrg,
  route,
  serviceJson,
} from './helpers.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The Files resources Cloud's Files and editor screens use. Anything else under
 * the Files service (bootstrap, desktop sync, agent runs) stays unreachable.
 */
const RESOURCES = new Set([
  'files',
  'documents',
  'trash',
  'shared',
  'content-requests',
  'link-requests',
  'collections',
]);

export function registerFilesRoutes(router: Router, { clients }: RouteContext): void {
  router.use('/cloud-files/v1', route(async(request, response) => {
    if (!METHODS.has(request.method)) throw httpError(405, 'method_not_allowed');
    const segments = proxySuffix(request);
    const resource = segments[0] ?? 'files';
    if (!RESOURCES.has(resource)) throw httpError(404, 'not_found');
    const org = requestedOrg(request);
    const path = `/v1/${[resource, ...segments.slice(1)].join('/')}${forwardedQuery(request)}`;
    response.json(await serviceJson(request, clients, 'files', org, path));
  }));
}
