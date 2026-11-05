// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentDockerRunPolicy } from '@pkg/agent/tools/docker/AgentDockerRunPolicy';

const identity = { jobId: 'job-42', agentId: 'codex-sol-worker' };

describe('AgentDockerRunPolicy', () => {
  it('labels ordinary runs as agent-owned temporary containers with a four-hour expiry', () => {
    // risk: orphaned agent containers survive app and VM restarts indefinitely
    const result = new AgentDockerRunPolicy(() => 1_000).apply({ options: '-d' }, identity);
    expect(result.labels).toMatchObject({
      'com.sulla.owner': 'agent', 'com.sulla.job-id': 'job-42', 'com.sulla.agent-id': 'codex-sol-worker',
      'com.sulla.expires-at': String(1_000 + 14_400), 'com.sulla.persistent': 'false',
    });
    expect(result.options).toContain('com.sulla.owner=agent');
  });

  it('refuses restart policies unless persistence has an audit reason', () => {
    // risk: restart policies resurrect forgotten previews on every VM boot
    const policy = new AgentDockerRunPolicy(() => 1_000);
    expect(() => policy.apply({ options: '--restart unless-stopped' }, identity)).toThrow(/restart policies are refused/);
    expect(() => policy.apply({ options: '--restart=always', persistent: true }, identity)).toThrow(/requires a non-empty reason/);
    expect(policy.apply({ options: '--restart=always', persistent: true, reason: 'local database' }, identity).labels)
      .toMatchObject({ 'com.sulla.persistent': 'true', 'com.sulla.persistence-reason': 'local database' });
  });
});
