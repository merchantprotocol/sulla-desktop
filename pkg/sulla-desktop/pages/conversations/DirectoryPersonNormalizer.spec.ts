// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { DirectoryPersonNormalizer } from './DirectoryPersonNormalizer';

describe('DirectoryPersonNormalizer', () => {
  const normalizer = new DirectoryPersonNormalizer();

  it('maps the production snake_case directory row, with agent_host_active 1 and 0, to agentHostOnline', () => {
    // risk: data accuracy; a lost agent flag hides a member's agent line
    const online = normalizer.normalize({ id: 'u-1', name: 'Grace Hopper', agent_host_active: 1 });
    const offline = normalizer.normalize({ id: 'u-2', name: 'Alan Turing', agent_host_active: 0 });
    expect(online).toMatchObject({ userId: 'u-1', displayName: 'Grace Hopper', agentHostOnline: true });
    expect(offline).toMatchObject({ userId: 'u-2', displayName: 'Alan Turing', agentHostOnline: false });
  });

  it('accepts boolean agent_host_active and keeps already-camelCase fields', () => {
    // risk: data accuracy; newer hosts send camelCase and must not lose fields
    const row = normalizer.normalize({ userId: 'u-3', displayName: 'Ada', agent_host_active: true, presence: 'busy', agentName: 'Ada agent' });
    expect(row).toMatchObject({ userId: 'u-3', displayName: 'Ada', agentHostOnline: true, presence: 'busy', agentName: 'Ada agent' });
  });

  it('prefers camelCase agentHostOnline over agent_host_active when both exist', () => {
    // risk: data accuracy; the newer explicit field wins
    expect(normalizer.normalize({ id: 'u-4', name: 'Sam', agentHostOnline: false, agent_host_active: 1 }).agentHostOnline).toBe(false);
  });

  it('leaves agentHostOnline unset when the directory reports no agent flag', () => {
    // risk: data accuracy; no flag must not be read as offline
    const row = normalizer.normalize({ id: 'u-5', name: 'Lee' });
    expect(row).not.toHaveProperty('agentHostOnline');
    expect(row.userId).toBe('u-5');
  });

  it('merges owner, admin and member roles by userId', () => {
    // risk: permissions; the role pill must match the membership record for that person
    const people = normalizer.withRoles(
      [{ id: 'u-1', name: 'Ada' }, { id: 'u-2', name: 'Grace' }, { id: 'u-3', name: 'Alan' }],
      [{ userId: 'u-1', role: 'owner' }, { userId: 'u-2', role: 'admin' }, { userId: 'u-3', role: 'member' }],
    );
    expect(people.map(person => person.role)).toEqual(['owner', 'admin', 'member']);
  });

  it('gives no role when the memberships read failed or is empty, so no wrong Member pill shows', () => {
    // risk: data accuracy; a failed role read must not show every person as Member
    const people = normalizer.withRoles([{ id: 'u-1', name: 'Ada' }], []);
    expect(people[0]).not.toHaveProperty('role');
  });

  it('drops an unknown role value instead of showing it', () => {
    // risk: permissions; only the three known roles may render
    const people = normalizer.withRoles([{ id: 'u-1', name: 'Ada' }], [{ userId: 'u-1', role: 'superuser' }]);
    expect(people[0]).not.toHaveProperty('role');
  });
});
