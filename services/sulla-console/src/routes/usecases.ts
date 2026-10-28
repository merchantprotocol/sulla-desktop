// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Router } from 'express';

import { UpstreamError } from '../clients/upstream.js';
import { envelope } from '../envelope.js';
import { requireOrganizationAdmin } from '../orgScope.js';
import {
  type RouteContext,
  forwardedQuery,
  httpError,
  param,
  proxySuffix,
  requestedOrg,
  route,
  session,
} from './helpers.js';

/**
 * The only Cloud marketplace calls the server's license may be used for:
 * browsing and template detail, and installing a template. `*` is one path segment.
 */
const MARKETPLACE_ROUTES: Array<{ method: string; pattern: string[] }> = [
  { method: 'GET', pattern: ['browse'] },
  { method: 'GET', pattern: ['kinds'] },
  { method: 'GET', pattern: ['topics'] },
  { method: 'GET', pattern: ['templates', '*'] },
  { method: 'POST', pattern: ['templates', '*', 'install'] },
];

function allowedMarketplaceCall(method: string, segments: string[]): boolean {
  return MARKETPLACE_ROUTES.some(allowed => allowed.method === method &&
    allowed.pattern.length === segments.length &&
    allowed.pattern.every((part, index) => part === '*' || part === segments[index]));
}

export function registerUseCaseRoutes(router: Router, { db, license }: RouteContext): void {
  router.use('/marketplace', route(async(request, response) => {
    const segments = proxySuffix(request);
    if (!allowedMarketplaceCall(request.method, segments)) throw httpError(404, 'not_found');
    const org = requestedOrg(request);
    if (request.method !== 'GET') requireOrganizationAdmin(session(request), org);
    const path = `/marketplace/${segments.map(encodeURIComponent).join('/')}${forwardedQuery(request)}`;
    const init: RequestInit = request.method === 'GET'
      ? { method: 'GET' }
      : { method: request.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) };
    const upstream = await license.cloudRequest(path, init);
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new UpstreamError(upstream.status, body);
    response.status(upstream.status).json(envelope(org, body));
  }));

  router.get('/cloud-usecase-installs/v1/library', route(async(request, response) => {
    const org = requestedOrg(request);
    const found = await db.query(
      'SELECT * FROM sulla_console.usecase_installs WHERE organization_id=$1 ORDER BY installed_at DESC',
      [org],
    );
    response.json(envelope(org, found.rows));
  }));

  router.get('/cloud-usecase-installs/v1/templates/:templateId/installs', route(async(request, response) => {
    const org = requestedOrg(request);
    const found = await db.query(
      'SELECT * FROM sulla_console.usecase_installs WHERE organization_id=$1 AND template_id=$2',
      [org, param(request, 'templateId')],
    );
    response.json(envelope(org, found.rows));
  }));

  router.get('/cloud-usecase-installs/v1/templates/:templateId/review', route(async(request, response) => {
    const org = requestedOrg(request);
    response.json(envelope(org, {
      templateId: param(request, 'templateId'),
      targets: String(request.query.targets ?? 'server').split(','),
      installable: license.status().catalogAllowed,
    }));
  }));
}
