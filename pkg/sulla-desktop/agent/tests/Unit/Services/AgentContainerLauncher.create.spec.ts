// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { createAgentContainer, removeAgentContainer, AgentLaunchError } from '../../../services/AgentContainerLauncher';

const spec = { name: 'sulla-agent-chat-test-0', image: 'agent-image' } as any;

describe('createAgentContainer', () => {
  it('removes an untracked owned container and retries a name conflict once', async() => {
    // risk: stale --rm cleanup race leaves every new chat turn failing with Docker Conflict
    const runtime = {
      create: vi.fn().mockRejectedValueOnce(new Error('Conflict. The container name is already in use')).mockResolvedValueOnce('new-id'),
      inspect: vi.fn().mockResolvedValue({ Id: 'stale-id', Config: { Labels: { 'com.sulla.workload': 'agent' } } }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as any;
    await expect(createAgentContainer(runtime, spec)).resolves.toBe('new-id');
    expect(runtime.remove).toHaveBeenCalledTimes(1);
    expect(runtime.create).toHaveBeenCalledTimes(2);
  });

  it('does not remove a container owned by a live lifecycle', async() => {
    // risk: concurrent chat launch deletes the active lifecycle container and kills its turn
    const runtime = {
      create: vi.fn().mockResolvedValueOnce('live-id').mockRejectedValueOnce(new Error('Conflict. name already in use')),
      inspect: vi.fn(), remove: vi.fn(),
    } as any;
    await createAgentContainer(runtime, { ...spec, name: 'sulla-agent-chat-live-test-0' });
    await expect(createAgentContainer(runtime, { ...spec, name: 'sulla-agent-chat-live-test-0' }))
      .rejects.toMatchObject({ name: 'AgentLaunchError', message: expect.stringMatching(/already using/) });
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('replaces a tracked container that is exited instead of treating it as live', async() => {
    // risk: a dead container permanently blocks new turns for its thread
    const name = 'sulla-agent-chat-exited-test-0';
    const runtime = {
      create: vi.fn().mockResolvedValueOnce('old-id').mockRejectedValueOnce(new Error('Conflict. name already in use'))
        .mockResolvedValueOnce('replacement-id'),
      inspect: vi.fn().mockResolvedValue({ Id: 'old-id', State: { Running: false, Restarting: false }, Config: { Labels: { 'com.sulla.workload': 'agent' } } }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as any;
    await createAgentContainer(runtime, { ...spec, name });
    await expect(createAgentContainer(runtime, { ...spec, name })).resolves.toBe('replacement-id');
    expect(runtime.inspect).toHaveBeenCalledTimes(1);
    expect(runtime.remove).toHaveBeenCalledTimes(1);
    expect(runtime.create).toHaveBeenCalledTimes(3);
  });

  it('clears the live-name marker even when container removal fails', async() => {
    // risk: a transient cleanup failure makes every later turn fail until app restart
    const name = 'sulla-agent-chat-remove-failure-test-0';
    const runtime = {
      create: vi.fn().mockResolvedValueOnce('live-id').mockRejectedValueOnce(new Error('Conflict. name already in use'))
        .mockResolvedValueOnce('replacement-id'),
      inspect: vi.fn().mockResolvedValue({ Id: 'stale-id', Config: { Labels: { 'com.sulla.workload': 'agent' } } }),
      remove: vi.fn().mockRejectedValueOnce(new Error('temporary runtime failure')).mockResolvedValueOnce(undefined),
    } as any;
    await createAgentContainer(runtime, { ...spec, name });
    await expect(removeAgentContainer(runtime, 'live-id', name, 'test', 'test')).rejects.toThrow('temporary runtime failure');
    await expect(createAgentContainer(runtime, { ...spec, name })).resolves.toBe('replacement-id');
    expect(runtime.inspect).toHaveBeenCalledTimes(1);
    expect(runtime.create).toHaveBeenCalledTimes(3);
  });
});
