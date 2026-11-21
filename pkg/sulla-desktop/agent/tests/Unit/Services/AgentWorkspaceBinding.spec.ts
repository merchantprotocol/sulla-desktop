// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { bindAgentWorkspace } from '../../../services/AgentWorkspaceBinding';

const operations = () => ({
  createEphemeral: vi.fn((jobKey: string) => Promise.resolve(`/runtime/agents/${ jobKey }-random`)),
  seedEphemeral:   vi.fn((_source: string, jobKey: string) => Promise.resolve(`/runtime/agents/${ jobKey }-seeded`)),
  seedStable:      vi.fn((_source: string, stable: string) => Promise.resolve(stable)),
});

describe('bindAgentWorkspace', () => {
  it('initializes an explicit seed inside the stable delegated workspace', async() => {
    // risk: every wake clones the seed into a new random workspace and loses prior edits.
    const ports = operations();
    const result = await bindAgentWorkspace({ jobKey: 'job-1-0', source: '/mnt/worktrees/repo', stableWorkspace: '/runtime/conversations/key/workspace' }, ports);

    expect(result).toBe('/runtime/conversations/key/workspace');
    expect(ports.seedStable).toHaveBeenCalledWith('/mnt/worktrees/repo', '/runtime/conversations/key/workspace');
    expect(ports.seedEphemeral).not.toHaveBeenCalled();
  });

  it('reopens an unseeded stable workspace without allocating another directory', async() => {
    const ports = operations();
    expect(await bindAgentWorkspace({ jobKey: 'job-1-0', stableWorkspace: '/runtime/conversations/key/workspace' }, ports))
      .toBe('/runtime/conversations/key/workspace');
    expect(ports.createEphemeral).not.toHaveBeenCalled();
  });

  it('retains the legacy ephemeral behavior only for a lifecycle without a persistence key', async() => {
    const ports = operations();
    expect(await bindAgentWorkspace({ jobKey: 'job-1-0', source: '/mnt/worktrees/repo' }, ports))
      .toBe('/runtime/agents/job-1-0-seeded');
    expect(ports.seedEphemeral).toHaveBeenCalledOnce();
  });
});
