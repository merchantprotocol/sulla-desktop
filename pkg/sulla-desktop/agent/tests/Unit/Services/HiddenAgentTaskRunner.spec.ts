// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { HiddenAgentTaskRunner } from '../../../services/HiddenAgentTaskRunner';
import { RunActivityService } from '../../../services/RunActivity';

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

  it('holds app activity for the same hidden-run lifetime and releases shared job keys after every task ends', async() => {
    // risk: hidden workers are App-Napped while running, or sibling completion drops another worker's hold
    let finishFirst!: (result: any) => void;
    let finishSecond!: (result: any) => void;
    const firstRun = new Promise<any>(resolve => { finishFirst = resolve });
    const secondRun = new Promise<any>(resolve => { finishSecond = resolve });
    const execute = vi.fn().mockImplementationOnce(() => firstRun).mockImplementationOnce(() => secondRun);
    const workActivity = { hiddenRunnerStarted: vi.fn(), hiddenRunnerEnded: vi.fn() };
    const chatActivity = { acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() };
    const runActivity = new RunActivityService({ now: () => 100, toWallTime: logicalTime => logicalTime }, chatActivity);
    const runner = new HiddenAgentTaskRunner({ execute }, workActivity, runActivity);
    const first = runner.run({
      task: { agentId: 'worker', label: 'first', prompt: 'work', status: 'running' },
      taskIndex: 0,
      threadId: 'first-thread',
      generation: 1,
      activityKeys: ['job-one', 'job-one#0'],
    });
    const second = runner.run({
      task: { agentId: 'worker', label: 'second', prompt: 'work', status: 'running' },
      taskIndex: 1,
      threadId: 'second-thread',
      generation: 1,
      activityKeys: ['job-one', 'job-one#1'],
    });

    expect(chatActivity.acquireChatActivity).toHaveBeenCalledWith('run:job-one');
    expect(chatActivity.acquireChatActivity).toHaveBeenCalledWith('run:job-one#0');
    expect(chatActivity.acquireChatActivity).toHaveBeenCalledWith('run:job-one#1');
    expect(runActivity.lastActivityAt('job-one')).toBe(100);
    expect(workActivity.hiddenRunnerStarted).toHaveBeenCalledTimes(2);

    finishFirst({ label: 'first', status: 'completed', output: 'done', threadId: 'first-thread' });
    await first;
    expect(chatActivity.releaseChatActivity).not.toHaveBeenCalledWith('run:job-one');
    expect(runActivity.lastActivityAt('job-one')).toBe(100);

    finishSecond({ label: 'second', status: 'completed', output: 'done', threadId: 'second-thread' });
    await second;
    expect(chatActivity.releaseChatActivity).toHaveBeenCalledWith('run:job-one');
    expect(runActivity.lastActivityAt('job-one')).toBeUndefined();
    expect(runActivity.lastActivityAt('job-one#0')).toBeUndefined();
    expect(runActivity.lastActivityAt('job-one#1')).toBeUndefined();
    expect(workActivity.hiddenRunnerEnded).toHaveBeenCalledTimes(2);
  });
});
