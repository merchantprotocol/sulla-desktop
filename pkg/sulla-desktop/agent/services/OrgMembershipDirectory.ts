// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaCloudHttpClient } from '@pkg/main/cloud/account/SullaCloudHttpClient';

/** One organization the signed-in human currently belongs to. */
export interface OrgMembership {
  orgId: string;
  name: string;
  slug?: string;
  /** Active members including the signed-in human. */
  memberCount: number;
}

/** Where the membership list comes from. */
export interface OrgMembershipSource {
  organizations(): Promise<readonly OrgMembership[]>;
}

export interface OrgMembershipAuth {
  accessToken(): Promise<string>;
}

class DesktopOrgMembershipAuth implements OrgMembershipAuth {
  async accessToken(): Promise<string> { return (await import('@pkg/main/sullaCloudAuth')).getCurrentAccessToken(); }
}

interface CloudOrganizationSummary { id?: unknown; name?: unknown; slug?: unknown; memberCount?: unknown }

/** Reads GET /cloud-dashboard/v1/organizations: every org the authenticated user is an active member of. */
export class CloudOrgMembershipSource implements OrgMembershipSource {
  constructor(
    private readonly http = new SullaCloudHttpClient(),
    private readonly auth: OrgMembershipAuth = new DesktopOrgMembershipAuth(),
  ) {}

  async organizations(): Promise<readonly OrgMembership[]> {
    const token = await this.auth.accessToken();
    if (!token) throw new Error('Sulla Cloud session is not ready; retry loading organizations');
    const response = await this.http.send('/cloud-dashboard/v1/organizations', { headers: { Authorization: `Bearer ${token}` } }, true);
    if (!response.ok) throw new Error(`Could not list Sulla Cloud organizations (${response.status})`);
    const body = await response.json() as { data?: { organizations?: CloudOrganizationSummary[] } };
    return (body.data?.organizations ?? [])
      .filter(org => typeof org.id === 'string' && org.id.trim())
      .map(org => ({
        orgId: String(org.id),
        name: typeof org.name === 'string' && org.name.trim() ? org.name.trim() : String(org.id),
        slug: typeof org.slug === 'string' && org.slug ? org.slug : undefined,
        memberCount: Number(org.memberCount ?? 0) || 0,
      }));
  }
}

/** Thrown when an org is requested that the signed-in human does not belong to. */
export class OrgMembershipRequiredError extends Error {
  constructor(requested: string) {
    super(`You are not a member of the organization "${requested}"`);
    this.name = 'OrgMembershipRequiredError';
  }
}

/**
 * Cached view of the organizations the signed-in human belongs to. `refresh()` is
 * the single place that talks to Cloud; lookups resolve by id, slug or name.
 */
export class OrgMembershipDirectory {
  private memberships: readonly OrgMembership[] = [];
  private loaded = false;

  constructor(private readonly source: OrgMembershipSource = new CloudOrgMembershipSource()) {}

  /** Re-reads membership from Cloud. Throws on transport failure and keeps the last good list. */
  async refresh(): Promise<readonly OrgMembership[]> {
    this.memberships = [...await this.source.organizations()];
    this.loaded = true;
    return this.memberships;
  }

  /** Last successfully loaded list (empty before the first refresh). */
  list(): readonly OrgMembership[] { return this.memberships; }

  /** Clears cached membership, e.g. on sign-out. */
  clear(): void {
    this.memberships = [];
    this.loaded = false;
  }

  /**
   * Resolves an org by id, slug or case-insensitive name. Refreshes once when the
   * org is not in the cache so a just-joined org works, and refuses non-members.
   */
  async require(requested: string): Promise<OrgMembership> {
    const key = requested.trim();
    if (!key) throw new OrgMembershipRequiredError(requested);
    const cached = this.loaded ? this.match(key) : undefined;
    if (cached) return cached;
    await this.refresh();
    const found = this.match(key);
    if (!found) throw new OrgMembershipRequiredError(key);
    return found;
  }

  private match(key: string): OrgMembership | undefined {
    const lower = key.toLowerCase();
    return this.memberships.find(org => org.orgId === key)
      ?? this.memberships.find(org => org.slug?.toLowerCase() === lower)
      ?? this.memberships.find(org => org.name.toLowerCase() === lower);
  }
}
