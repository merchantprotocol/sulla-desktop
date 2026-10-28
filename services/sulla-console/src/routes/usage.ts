// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Request, Router } from 'express';

import type { Database } from '../db.js';
import { envelope } from '../envelope.js';
import { requireOrganizationAdmin } from '../orgScope.js';
import { type RouteContext, httpError, requestedOrg, route, session } from './helpers.js';

const CAP_ACTIONS = new Set(['block', 'ask']);

async function usageSettings(db: Database, org: string) {
  const found = await db.query('SELECT * FROM sulla_console.usage_settings WHERE organization_id=$1', [org]);
  return found.rows[0] ?? { organization_id: org, monthly_token_cap: null, action: 'block' };
}

function periodDays(request: Request): number {
  const days = Number(request.query.period ?? 30) || 30;
  return Math.min(366, Math.max(1, days));
}

function tokenCap(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw httpError(400, 'invalid_token_cap');
  return value;
}

export function registerUsageRoutes(router: Router, { db }: RouteContext): void {
  router.get('/usage/tokens', route(async(request, response) => {
    const org = requestedOrg(request);
    const found = await db.query(
      `SELECT date_trunc('day',created_at) AS day,source,model,provider,
              sum(input_tokens)::bigint AS input_tokens,sum(output_tokens)::bigint AS output_tokens
       FROM sulla_console.usage_events
       WHERE organization_id=$1 AND created_at >= now()-($2::text || ' days')::interval
       GROUP BY 1,2,3,4 ORDER BY 1`,
      [org, periodDays(request)],
    );
    response.json(envelope(org, found.rows));
  }));

  router.get('/usage/summary', route(async(request, response) => {
    const org = requestedOrg(request);
    const found = await db.query(
      `SELECT count(*)::int AS runs,coalesce(sum(duration_ms),0)::bigint AS duration_ms,
              coalesce(sum(input_tokens+output_tokens),0)::bigint AS tokens
       FROM sulla_console.usage_events WHERE organization_id=$1`,
      [org],
    );
    response.json(envelope(org, found.rows[0]));
  }));

  for (const path of ['/usage/token-caps', '/usage/settings']) {
    router.get(path, route(async(request, response) => {
      const org = requestedOrg(request);
      response.json(envelope(org, await usageSettings(db, org)));
    }));
  }

  router.put('/usage/settings', route(async(request, response) => {
    const org = requestedOrg(request);
    requireOrganizationAdmin(session(request), org);
    const action = String(request.body?.action ?? 'block');
    if (!CAP_ACTIONS.has(action)) throw httpError(400, 'invalid_action');
    const found = await db.query(
      `INSERT INTO sulla_console.usage_settings(organization_id,monthly_token_cap,action) VALUES($1,$2,$3)
       ON CONFLICT(organization_id) DO UPDATE
       SET monthly_token_cap=excluded.monthly_token_cap,action=excluded.action,updated_at=now()
       RETURNING *`,
      [org, tokenCap(request.body?.monthlyTokenCap), action],
    );
    response.json(envelope(org, found.rows[0]));
  }));
}
