// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const CLERK_ACCOUNT = 'default';
export const CLERK_OPERATION = 'clerk.backend';
export const CLERK_APPROVAL_MS = 10 * 60_000;
export const CLERK_DEADLINE_MS = 15_000;
export const CLERK_ENVIRONMENTS = ['staging', 'production'] as const;
export type ClerkEnvironment = typeof CLERK_ENVIRONMENTS[number];

interface ClerkEndpoint {
  description:    string;
  method:         'GET' | 'POST' | 'PATCH' | 'DELETE';
  path:           string;
  paged?:         boolean;
  defaultStatus?: string;
  body?:          boolean;
  optionalBody?:  boolean;
}

const users = '/users';
const user = '/users/{user_id}';
const orgs = '/organizations';
const org = '/organizations/{organization_id}';
const memberships = `${ org }/memberships`;
const orgInvites = `${ org }/invitations`;
const invites = '/invitations';
const sessions = '/sessions';
const session = `${ sessions }/{session_id}`;

/** Clerk's published OpenAPI: https://clerk.com/docs/reference/backend-api */
export const clerkEndpoints: Readonly<Record<string, ClerkEndpoint>> = {
  list_users:                     { description: 'List or search Clerk users. Use filters.query for text search.', method: 'GET', path: users, paged: true },
  count_users:                    { description: 'Count Clerk users matching the supplied filters.', method: 'GET', path: '/users/count' },
  get_user:                       { description: 'Get a Clerk user by ID.', method: 'GET', path: user },
  create_user:                    { description: 'Create a Clerk user with Clerk JSON fields such as email_address, first_name, and last_name.', method: 'POST', path: users, body: true },
  update_user:                    { description: 'Update a Clerk user.', method: 'PATCH', path: user, body: true },
  update_user_metadata:           { description: 'Merge a user’s public_metadata, private_metadata, and/or unsafe_metadata.', method: 'PATCH', path: `${ user }/metadata`, body: true },
  ban_user:                       { description: 'Ban a Clerk user.', method: 'POST', path: `${ user }/ban` },
  unban_user:                     { description: 'Unban a Clerk user.', method: 'POST', path: `${ user }/unban` },
  lock_user:                      { description: 'Lock a Clerk user.', method: 'POST', path: `${ user }/lock` },
  unlock_user:                    { description: 'Unlock a Clerk user.', method: 'POST', path: `${ user }/unlock` },
  delete_user:                    { description: 'Permanently delete a Clerk user.', method: 'DELETE', path: user },
  list_organizations:             { description: 'List Clerk organizations.', method: 'GET', path: orgs, paged: true },
  get_organization:               { description: 'Get a Clerk organization by ID.', method: 'GET', path: org },
  create_organization:            { description: 'Create a Clerk organization. Supply a name in the JSON body.', method: 'POST', path: orgs, body: true },
  update_organization:            { description: 'Update a Clerk organization.', method: 'PATCH', path: org, body: true },
  update_organization_metadata:   { description: 'Merge an organization’s public_metadata and/or private_metadata.', method: 'PATCH', path: `${ org }/metadata`, body: true },
  delete_organization:            { description: 'Permanently delete a Clerk organization.', method: 'DELETE', path: org },
  list_memberships:               { description: 'List Clerk organization memberships.', method: 'GET', path: memberships, paged: true },
  add_membership:                 { description: 'Add a member to a Clerk organization. Supply user_id and role in the JSON body.', method: 'POST', path: memberships, body: true },
  update_membership:              { description: 'Change a Clerk organization member’s role.', method: 'PATCH', path: `${ memberships }/{user_id}`, body: true },
  remove_membership:              { description: 'Remove a member from a Clerk organization.', method: 'DELETE', path: `${ memberships }/{user_id}` },
  list_organization_invitations:  { description: 'List Clerk organization invitations, pending by default.', method: 'GET', path: orgInvites, paged: true, defaultStatus: 'pending' },
  create_organization_invitation: { description: 'Invite someone to a Clerk organization. Supply email_address and role in the JSON body.', method: 'POST', path: orgInvites, body: true },
  revoke_organization_invitation: { description: 'Revoke a pending Clerk organization invitation.', method: 'POST', path: `${ orgInvites }/{invitation_id}/revoke`, optionalBody: true },
  list_invitations:               { description: 'List Clerk instance invitations.', method: 'GET', path: invites, paged: true },
  create_invitation:              { description: 'Send a Clerk instance invitation. Supply email_address in the JSON body.', method: 'POST', path: invites, body: true },
  revoke_invitation:              { description: 'Revoke a Clerk instance invitation.', method: 'POST', path: `${ invites }/{invitation_id}/revoke` },
  list_sessions:                  { description: 'List active Clerk sessions for a user or client by default. Supply filters.user_id or filters.client_id. Note: Clerk’s Backend API can include pending sessions when status is active; check each session’s status field.', method: 'GET', path: sessions, paged: true, defaultStatus: 'active' },
  get_session:                    { description: 'Get a Clerk session by ID.', method: 'GET', path: session },
  revoke_session:                 { description: 'Revoke a Clerk session. Optionally set reset_client_trust to true to reset client trust.', method: 'POST', path: `${ session }/revoke`, optionalBody: true },
  list_allowlist_identifiers:     { description: 'List Clerk allowlist identifiers.', method: 'GET', path: '/allowlist_identifiers' },
  add_allowlist_identifier:       { description: 'Add a Clerk allowlist identifier. Supply identifier in the JSON body.', method: 'POST', path: '/allowlist_identifiers', body: true },
  remove_allowlist_identifier:    { description: 'Remove an identifier from the Clerk allowlist.', method: 'DELETE', path: '/allowlist_identifiers/{identifier_id}' },
  list_blocklist_identifiers:     { description: 'List Clerk blocklist identifiers.', method: 'GET', path: '/blocklist_identifiers' },
  add_blocklist_identifier:       { description: 'Add a Clerk blocklist identifier. Supply identifier in the JSON body.', method: 'POST', path: '/blocklist_identifiers', body: true },
  remove_blocklist_identifier:    { description: 'Remove an identifier from the Clerk blocklist.', method: 'DELETE', path: '/blocklist_identifiers/{identifier_id}' },
};
