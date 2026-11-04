// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentExecDockerPolicy } from '@pkg/agent/tools/docker/AgentExecDockerPolicy';

describe('AgentExecDockerPolicy', () => {
  const identity = { jobId: 'job-7', agentId: 'worker' };

  it('injects ownership labels into docker run issued through exec', () => {
    // risk: shell-launched containers bypass the catalog tool retention policy
    const command = new AgentExecDockerPolicy().apply('docker run -d nginx', {}, identity);
    expect(command).toContain("'com.sulla.owner=agent'");
    expect(command).toContain("'com.sulla.job-id=job-7'");
  });

  it('refuses compose up rather than launching unlabeled or restartable services', () => {
    // risk: compose creates a fleet of unowned restartable containers
    expect(() => new AgentExecDockerPolicy().apply('docker compose up -d', {}, identity)).toThrow(/compose up.*refused/);
  });
});
