// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { CloudOrgMembershipSource, type OrgMembershipAuth } from '../../../services/OrgMembershipDirectory';

describe('CloudOrgMembershipSource', () => {
  it('retries after an initially missing token instead of caching an empty membership result', async () => {
    // risk: data accuracy — a restored Cloud session eventually exposes its member teams
    let token = '';
    let calls = 0;
    const auth: OrgMembershipAuth = { accessToken: async () => token };
    const http = { send: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ data: { organizations: [{ id: 'team-1', name: 'One-person team', memberCount: 1 }] } }) } as Response;
    } };
    const source = new CloudOrgMembershipSource(http as any, auth);

    await expect(source.organizations()).rejects.toThrow('session is not ready');
    token = 'restored-token';
    await expect(source.organizations()).resolves.toEqual([{ orgId: 'team-1', name: 'One-person team', slug: undefined, memberCount: 1 }]);
    expect(calls).toBe(1);
  });
});
