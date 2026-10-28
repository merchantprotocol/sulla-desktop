// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Request, Router } from 'express';

import { isServerAdmin, requireOrganization } from '../orgScope.js';
import { type RouteContext, httpError, param, route, session, teamOrg, webInit } from './helpers.js';

interface AccountsUser {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  membership?: { roles?: string[]; created_at?: string };
}

interface AccountsInvitation {
  id: string;
  email: string;
  roles?: string[];
  expires_at?: string;
  accepted_at?: string | null;
  revoked_at?: string | null;
  created_at?: string;
}

function primaryRole(roles: string[] = []): string {
  if (roles.includes('owner')) return 'owner';
  if (roles.includes('admin')) return 'admin';
  return 'member';
}

/** Cloud's screens send a single `role` of member or admin; Accounts takes a `roles` list. */
function requestedRoles(request: Request): string[] {
  return [request.body?.role === 'admin' ? 'admin' : 'member'];
}

function memberView(user: AccountsUser) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return {
    id: user.id,
    userId: user.id,
    name: name || user.username || user.email,
    email: user.email,
    role: primaryRole(user.membership?.roles),
    roles: user.membership?.roles ?? [],
    joinedAt: user.membership?.created_at,
  };
}

function invitationView(invitation: AccountsInvitation) {
  const expired = invitation.expires_at ? Date.parse(invitation.expires_at) < Date.now() : false;
  return {
    id: invitation.id,
    email: invitation.email,
    role: primaryRole(invitation.roles),
    roles: invitation.roles ?? [],
    status: expired ? 'expired' : 'pending',
    expiresAt: invitation.expires_at,
    createdAt: invitation.created_at,
  };
}

function organizationPath(id: string, suffix = ''): string {
  return `/v1/web/organizations/${encodeURIComponent(id)}${suffix}`;
}

export function registerTeamRoutes(router: Router, { clients }: RouteContext): void {
  const accounts = clients.accounts;

  router.get('/teams', route(async(request, response) => {
    const data = await accounts.request<{ organizations: unknown[] }>('/v1/web/organizations', webInit(request));
    response.json(data.organizations);
  }));

  router.post('/teams', route(async(request, response) => {
    if (!isServerAdmin(session(request))) throw httpError(403, 'server_admin_required');
    const body = { name: request.body?.name, slug: request.body?.slug };
    response.status(201).json(await accounts.request('/v1/web/organizations', webInit(request, 'POST', body)));
  }));

  router.get('/teams/:id', route(async(request, response) => {
    const id = teamOrg(request);
    const path = `/v1/web/overview?organizationId=${encodeURIComponent(id)}`;
    response.json(await accounts.request(path, webInit(request)));
  }));

  router.patch('/teams/:id', route(async(request, response) => {
    const id = teamOrg(request);
    const body = { name: request.body?.name };
    const init = webInit(request, 'PATCH', body);
    const result = await accounts.request<{ organization: unknown }>(organizationPath(id), init);
    response.json({ team: result.organization });
  }));

  router.post('/teams/:id/leave', route(async(request, response) => {
    const id = teamOrg(request);
    const path = `/v1/web/memberships/self?organizationId=${encodeURIComponent(id)}`;
    await accounts.request(path, webInit(request, 'DELETE'));
    response.status(204).end();
  }));

  router.get('/teams/:id/members', route(async(request, response) => {
    const id = teamOrg(request);
    const path = `/v1/web/users?organizationId=${encodeURIComponent(id)}`;
    const result = await accounts.request<{ users: AccountsUser[] }>(path, webInit(request));
    response.json({ members: result.users.map(memberView) });
  }));

  router.patch('/teams/:id/members/:userId', route(async(request, response) => {
    const id = teamOrg(request);
    const path = `/v1/web/users/${encodeURIComponent(param(request, 'userId'))}`;
    const body = { organizationId: id, roles: requestedRoles(request) };
    await accounts.request(path, webInit(request, 'PATCH', body));
    response.status(204).end();
  }));

  router.delete('/teams/:id/members/:userId', route(async(request, response) => {
    const id = teamOrg(request);
    const path = organizationPath(id, `/members/${encodeURIComponent(param(request, 'userId'))}`);
    await accounts.request(path, webInit(request, 'DELETE'));
    response.status(204).end();
  }));

  router.get('/teams/:id/invitations', route(async(request, response) => {
    const id = teamOrg(request);
    // Members load this alongside the member list; only owners and admins can see invitations.
    const roles = requireOrganization(session(request), id).roles;
    if (!roles.includes('owner') && !roles.includes('admin')) {
      response.json({ invitations: [] });
      return;
    }
    const path = organizationPath(id, '/invitations');
    const result = await accounts.request<{ invitations: AccountsInvitation[] }>(path, webInit(request));
    const open = result.invitations.filter(invitation => !invitation.accepted_at && !invitation.revoked_at);
    response.json({ invitations: open.map(invitationView) });
  }));

  router.post('/teams/:id/invitations', route(async(request, response) => {
    const id = teamOrg(request);
    const body = { email: request.body?.email, roles: requestedRoles(request) };
    const path = organizationPath(id, '/invitations');
    const result = await accounts.request<{ invitation: AccountsInvitation }>(path, webInit(request, 'POST', body));
    // Accounts sends the Keycloak set-password email before it answers.
    response.status(201).json({ invitation: invitationView(result.invitation), emailSent: true });
  }));

  router.delete('/teams/:id/invitations/:invitationId', route(async(request, response) => {
    const id = teamOrg(request);
    const path = organizationPath(id, `/invitations/${encodeURIComponent(param(request, 'invitationId'))}`);
    await accounts.request(path, webInit(request, 'DELETE'));
    response.status(204).end();
  }));

  router.post('/teams/:id/invitations/:invitationId/resend', route(async(request, response) => {
    const id = teamOrg(request);
    const path = organizationPath(id, `/invitations/${encodeURIComponent(param(request, 'invitationId'))}/resend`);
    await accounts.request(path, webInit(request, 'POST', {}));
    response.json({ emailSent: true });
  }));

  router.get('/invite/mine', route(async(request, response) => {
    response.json(await accounts.request('/v1/web/invite/mine', webInit(request)));
  }));

  router.post('/invite/mine/:invitationId/accept', route(async(request, response) => {
    const path = `/v1/web/invite/mine/${encodeURIComponent(param(request, 'invitationId'))}/accept`;
    await accounts.request(path, webInit(request, 'POST', {}));
    response.status(204).end();
  }));
}
