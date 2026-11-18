// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { cloudRequest } from './cloud/cloudFetch';

export interface OrgMembership { userId: string; name: string; role: 'owner' | 'admin' | 'member'; joinedAt: string; isPayer: boolean }

/** Loads cloudFetch on first call, so importing this client never pulls in the Cloud transport. */
class LazyCloudRequester {
  async request(...args: Parameters<typeof cloudRequest>): Promise<Response> {
    return (await import('./cloud/cloudFetch')).cloudRequest(...args);
  }
}

/** Reads org roles through the vault-brokered Cloud client. */
export class OrgMembershipsCloudClient {
  constructor(private readonly request: typeof cloudRequest = (...args) => new LazyCloudRequester().request(...args)) {}
  async list(orgId: string): Promise<OrgMembership[]> {
    const response = await this.request('GET', `/cloud-dashboard/v1/organizations/${encodeURIComponent(orgId)}/memberships`);
    if (!response.ok) throw new Error(`Organization memberships unavailable (${response.status})`);
    const body = await response.json() as { data?: { memberships?: OrgMembership[] } };
    return body.data?.memberships ?? [];
  }
}
