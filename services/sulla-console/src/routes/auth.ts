// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Router } from 'express';

import { isServerAdmin, requireOrganization } from '../orgScope.js';
import { type RouteContext, param, requestedOrg, route, session, webInit } from './helpers.js';

interface HostedProfile {
  id?: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

function displayName(profile: HostedProfile): string | undefined {
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
  return name || profile.username || profile.email;
}

export function registerAuthRoutes(router: Router, { db, clients }: RouteContext): void {
  router.get('/auth/me', route(async(request, response) => {
    const current = session(request);
    const prefs = await db.query(
      'SELECT active_org,timezone,colour FROM sulla_console.user_prefs WHERE issuer=$1 AND subject=$2',
      [current.identity.issuer, current.identity.subject],
    );
    const saved = prefs.rows[0];
    const savedOrgIsCurrent = current.organizations.some(organization => organization.id === saved?.active_org);
    const activeTeamId = savedOrgIsCurrent ? saved.active_org : current.organizations[0]?.id ?? null;
    const profile = await clients.accounts
      .request<{ profile: HostedProfile }>('/v1/web/profile', webInit(request, 'GET'))
      .then(result => result.profile)
      .catch(() => ({} as HostedProfile));
    response.json({
      contractor: {
        id: current.identity.subject,
        name: displayName(profile),
        email: profile.email,
        activeTeamId,
        memberships: current.organizations,
        isServerAdmin: isServerAdmin(current),
        timezone: saved?.timezone,
        colour: saved?.colour,
      },
    });
  }));

  router.post('/auth/switch-team', route(async(request, response) => {
    const current = session(request);
    const organizationId = String(request.body?.teamId ?? request.body?.organizationId ?? '');
    requireOrganization(current, organizationId);
    await db.query(
      `INSERT INTO sulla_console.user_prefs(issuer,subject,active_org) VALUES($1,$2,$3)
       ON CONFLICT(issuer,subject) DO UPDATE SET active_org=excluded.active_org,updated_at=now()`,
      [current.identity.issuer, current.identity.subject, organizationId],
    );
    response.json({ activeTeamId: organizationId });
  }));

  router.post('/auth/logout', route(async(request, response) => {
    const result = await clients.accounts.request<{ logoutUrl?: string }>(
      '/v1/web/logout',
      webInit(request, 'POST', {}),
    );
    response.json(result);
  }));

  router.get('/auth/sessions', route(async(request, response) => {
    const org = requestedOrg(request);
    const path = `/v1/web/sessions?organizationId=${encodeURIComponent(org)}`;
    response.json(await clients.accounts.request(path, webInit(request)));
  }));

  router.delete('/auth/sessions/:sessionId', route(async(request, response) => {
    const org = requestedOrg(request);
    const sessionId = param(request, 'sessionId');
    const path = `/v1/web/sessions/${encodeURIComponent(sessionId)}/revoke`;
    await clients.accounts.request(path, webInit(request, 'POST', { organizationId: org }));
    response.status(204).end();
  }));
}
