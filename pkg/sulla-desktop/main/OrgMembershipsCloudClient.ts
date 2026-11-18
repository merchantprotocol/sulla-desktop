// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { cloudRequest } from './cloud/cloudFetch';

export interface OrgMembership { userId: string; name: string; role: 'owner' | 'admin' | 'member'; joinedAt: string; isPayer: boolean }

/** Reads org roles through the vault-brokered Cloud client. */
export class OrgMembershipsCloudClient {
  constructor(private readonly request: typeof cloudRequest = cloudRequest) {}
  async list(orgId: string): Promise<OrgMembership[]> {
    const response = await this.request('GET', `/cloud-dashboard/v1/organizations/${encodeURIComponent(orgId)}/memberships`);
    if (!response.ok) throw new Error(`Organization memberships unavailable (${response.status})`);
    const body = await response.json() as { data?: { memberships?: OrgMembership[] } };
    return body.data?.memberships ?? [];
  }
}
