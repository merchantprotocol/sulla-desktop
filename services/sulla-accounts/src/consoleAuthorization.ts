import type { HostedUser } from './keycloakAdmin.js';

export function assertOrganizationUserMutation(input: Record<string, unknown>): void {
  if (input.enabled !== undefined || input.temporaryPassword !== undefined) {
    throw new Error('organization administrators cannot change global user credentials or status');
  }
}

export async function organizationUsers<T extends { subject: string }>(
  memberships: T[],
  lookup: (subject: string) => Promise<HostedUser>,
): Promise<Array<HostedUser & { membership: T }>> {
  return Promise.all(memberships.map(async membership => ({ ...await lookup(membership.subject), membership })));
}
