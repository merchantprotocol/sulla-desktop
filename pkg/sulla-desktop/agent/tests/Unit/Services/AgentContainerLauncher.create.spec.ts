// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { createAgentContainer, AgentLaunchError } from '../../../services/AgentContainerLauncher';

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
});
