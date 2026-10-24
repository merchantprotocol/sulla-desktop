// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { AccountsSession } from './clients/accounts.js';

export function requireOrganization(session: AccountsSession, organizationId: string) {
  const membership = session.organizations.find(organization => organization.id === organizationId);
  if (!membership) throw Object.assign(new Error('organization_forbidden'), { status: 403 });
  return membership;
}

export function isServerAdmin(session: AccountsSession): boolean {
  const identity = session.identity as AccountsSession['identity'] & { roles?: string[]; realmRoles?: string[] };
  const marked = session as AccountsSession & { serverAdmin?: boolean };
  return marked.serverAdmin === true || [...(identity.roles ?? []), ...(identity.realmRoles ?? [])].includes('server-admin');
}
