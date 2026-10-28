// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Request, Router } from 'express';

import { adminRoute, adminWrite, array, number, record, text } from './common.js';
import type { RouteContext } from '../routes/helpers.js';
import { param, session } from '../routes/helpers.js';

interface Membership {
  organization_id?: unknown;
  roles?: unknown;
  created_at?: unknown;
}

function displayName(user: Record<string, unknown>): string {
  const combined = [text(user.firstName), text(user.lastName)].filter(Boolean).join(' ');
  return combined || text(user.username) || text(user.email) || text(user.id, 'Unknown user');
}

function userView(request: Request, user: Record<string, unknown>) {
  const memberships = array(user.organizations) as Membership[];
  const roles = memberships.flatMap(membership => Array.isArray(membership.roles) ? membership.roles : []);
  const role = roles.includes('owner') ? 'owner' : roles.includes('admin') ? 'admin' : 'member';
  const joined = memberships.map(membership => text(membership.created_at)).filter(Boolean).sort()[0] ?? null;
  return {
    id: text(user.id),
    name: displayName(user),
    email: text(user.email),
    org: memberships.map(membership => text(membership.organization_id)).filter(Boolean).join(', '),
    role,
    status: user.enabled === false ? 'disabled' : 'active',
    joinedAt: joined,
    isServerAdmin: text(user.id) === session(request).identity.subject,
    isYou: text(user.id) === session(request).identity.subject,
  };
}

export function registerUsersRoutes(router: Router, context: RouteContext): void {
  router.get('/server/v1/users', adminRoute(async(request, response) => {
    const [usersResult, limitsResult] = await Promise.all([
      context.clients.accounts.admin<{ users?: unknown }>('/users'),
      context.clients.accounts.admin('/limits'),
    ]);
    const limits = record(limitsResult);
    response.json({
      edition: context.license.status().edition,
      seats: {
        used: number(limits.seatsUsed),
        total: limits.seatLimit == null ? null : number(limits.seatLimit),
      },
      users: array(usersResult.users).map(user => userView(request, user)),
    });
  }));

  for (const [suffix, enabled] of [['disable', false], ['enable', true]] as const) {
    router.post(`/server/v1/users/:id/${suffix}`, adminWrite(context, `admin.user.${suffix}`, async(request, response) => {
      await context.clients.accounts.admin(`/users/${encodeURIComponent(param(request, 'id'))}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      response.json({ ok: true });
    }));
  }
}
