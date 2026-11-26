// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { HiddenAgentTaskRunner } from '../../../services/HiddenAgentTaskRunner';
describe('HiddenAgentTaskRunner', () => {
  it('runs a persisted task with its existing thread and generation unchanged', async() => {
    // risk: reopen accidentally creates a new conversation or generation
    const execute = vi.fn(async(input: any) => ({ label: input.task.label, status: 'completed' as const, output: 'done', threadId: input.threadId }));
    const activity = { hiddenRunnerStarted: vi.fn(), hiddenRunnerEnded: vi.fn() };
    const runner = new HiddenAgentTaskRunner({ execute }, activity);
    const input = { task: { agentId: 'worker', label: 'lane', prompt: 'work', status: 'running' as const }, taskIndex: 0, threadId: 'existing-thread', generation: 2 };
    expect(await runner.run(input)).toMatchObject({ status: 'completed', threadId: 'existing-thread' });
    expect(execute).toHaveBeenCalledWith(input);
    expect(activity.hiddenRunnerStarted).toHaveBeenCalledWith('hidden:existing-thread');
    expect(activity.hiddenRunnerEnded).toHaveBeenCalledWith('hidden:existing-thread');
  });

  it('releases the live-run hold when task execution throws', async() => {
    const activity = { hiddenRunnerStarted: vi.fn(), hiddenRunnerEnded: vi.fn() };
    const runner = new HiddenAgentTaskRunner({ execute: vi.fn(async() => { throw new Error('synthetic failure') }) }, activity);
    const input = { task: { agentId: 'worker', label: 'lane', prompt: 'work', status: 'running' as const }, taskIndex: 0, threadId: 'failed-thread', generation: 1 };

    await expect(runner.run(input)).rejects.toThrow('synthetic failure');
    expect(activity.hiddenRunnerEnded).toHaveBeenCalledWith('hidden:failed-thread');
  });
});
