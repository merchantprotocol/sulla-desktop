// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { OrgMembershipsCloudClient } from './OrgMembershipsCloudClient';

describe('OrgMembershipsCloudClient', () => {
  it('reads memberships for the org id, encoded into the path, and returns the roster', async () => {
    // risk: permissions; roles must come from the requested org only
    const calls: string[] = [];
    const request = async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return new Response(JSON.stringify({ data: { memberships: [{ userId: 'u-1', name: 'Ada', role: 'owner', joinedAt: '2026-01-01', isPayer: true }] } }), { status: 200 });
    };
    const members = await new OrgMembershipsCloudClient(request as never).list('org/1');
    expect(calls).toEqual(['GET /cloud-dashboard/v1/organizations/org%2F1/memberships']);
    expect(members).toEqual([{ userId: 'u-1', name: 'Ada', role: 'owner', joinedAt: '2026-01-01', isPayer: true }]);
  });

  it('throws on a refused read so the caller shows no role pill', async () => {
    // risk: data accuracy; a failed read must surface as a failure, not an empty or wrong roster
    const request = async () => new Response('{}', { status: 403 });
    await expect(new OrgMembershipsCloudClient(request as never).list('org-1')).rejects.toThrow(/unavailable \(403\)/);
  });
});
