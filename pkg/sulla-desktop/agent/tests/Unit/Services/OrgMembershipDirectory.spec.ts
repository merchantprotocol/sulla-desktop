// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { CloudOrgMembershipSource } from '../../../services/OrgMembershipDirectory';

describe('CloudOrgMembershipSource', () => {
  it('uses the requester without a Desktop bearer and returns memberships', async () => {
    // risk: data accuracy — container-vault sessions must list the signed-in user's organizations
    let captured: unknown;
    const requester = async (method: string, path: string, options?: { headers?: Record<string, string> }): Promise<Response> => {
      captured = { method, path, headers: options?.headers };
      return new Response(JSON.stringify({ data: { organizations: [{ id: 'team-1', name: 'One-person team', memberCount: 1 }] } }), { status: 200 });
    };
    const source = new CloudOrgMembershipSource(requester);
    await expect(source.organizations()).resolves.toEqual([{ orgId: 'team-1', name: 'One-person team', slug: undefined, memberCount: 1 }]);
    expect(captured).toEqual({ method: 'GET', path: '/cloud-dashboard/v1/organizations', headers: undefined });
  });

  it('throws when Cloud rejects the membership request', async () => {
    // risk: data accuracy — transport/session errors must not masquerade as zero memberships
    const source = new CloudOrgMembershipSource(async () => new Response('{}', { status: 503 }));
    await expect(source.organizations()).rejects.toThrow('Could not list Sulla Cloud organizations (503)');
  });
});
