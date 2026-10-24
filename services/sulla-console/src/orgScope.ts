// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { AccountsSession } from './clients/accounts.js';

function forbidden(code: string): Error & { status: number } {
  return Object.assign(new Error(code), { status: 403 });
}

export function requireOrganization(session: AccountsSession, organizationId: string) {
  const membership = session.organizations.find(organization => organization.id === organizationId);
  if (!membership) throw forbidden('organization_forbidden');
  return membership;
}

/** Owners and admins of the organization, from the roles Accounts reports on the session. */
export function requireOrganizationAdmin(session: AccountsSession, organizationId: string) {
  const membership = requireOrganization(session, organizationId);
  if (!membership.roles.some(role => role === 'owner' || role === 'admin')) {
    throw forbidden('organization_admin_required');
  }
  return membership;
}

export function isServerAdmin(session: AccountsSession): boolean {
  return session.serverAdmin === true;
}
