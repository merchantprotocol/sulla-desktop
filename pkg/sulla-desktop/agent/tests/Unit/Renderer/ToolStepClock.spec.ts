// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { StatusRollupItem } from '@pkg/pages/chat/components/composer/StatusRollupQueue';
import { ToolStepClock } from '@pkg/pages/chat/components/transcript/ToolStepClock';

function toolEvent(overrides: Partial<StatusRollupItem>): StatusRollupItem {
  return {
    key: 'tool-event', threadId: 'parent', agentId: 'chat:parent', agentName: 'Sulla', kind: 'run',
    phase: 'start', correlationId: 'step-1', text: 'Running git', observedAt: 1_000, role: 'root', ...overrides,
  };
}

describe('ToolStepClock', () => {
  it('computes frozen and live durations from persisted epoch timestamps', () => {
    // risk: data accuracy — a 60s tool must show elapsed time and a completed step must freeze at endedAt.
    const clock = new ToolStepClock(() => 61_000);

    expect(clock.elapsedMs(1_000, 2_500)).toBe(1_500);
    expect(clock.durationLabel(clock.elapsedMs(1_000, 2_500))).toBe('1.5s');
    expect(clock.elapsedMs(1_000)).toBe(60_000);
    expect(clock.durationLabel(clock.elapsedMs(1_000))).toBe('1m 00s');
  });

  it('uses the persisted tool start instead of a later observation timestamp', () => {
    // risk: data accuracy — late renderer observation must not under-report tool elapsed time.
    const clock = new ToolStepClock(() => 61_000);
    const observedLate = toolEvent({ observedAt: 45_000, startedAt: 1_000 });

    expect(clock.elapsed(observedLate, 61_000)).toBe(60_000);
    expect(clock.durationLabel(clock.elapsed(observedLate, 61_000))).toBe('1m 00s');
  });

  it('keeps legacy fallback labels to tool names and Sulla tool identifiers', () => {
    // risk: privacy — old rows without meta.step must never turn a path, URL, or command into a visible label.
    const clock = new ToolStepClock();

    expect(clock.safeLabel(undefined, 'git')).toBe('git');
    expect(clock.safeLabel(undefined, 'mcp__search__run')).toBe('mcp__search__run');
    expect(clock.safeLabel(undefined, 'sulla github/create_issue')).toBe('sulla github/create_issue');
    expect(clock.safeLabel(undefined, 'vault/read')).toBe('vault/read');
    expect(clock.safeLabel(undefined, '/private/user/project')).toBe('shell');
    expect(clock.safeLabel(undefined, 'https://example.test/?token=synthetic')).toBe('shell');
    expect(clock.safeLabel(undefined, 'git status --short')).toBe('shell');
    expect(clock.safeLabel({ step: { stepId: 'python', runId: 'run-1', provider: 'codex', source: 'codex_cli',
      safeLabel: 'python3.12', startedAt: 1_000 } }, 'exec')).toBe('python3.12');
  });

  it('ticks all subscribers through one interval and stops it when no row remains subscribed', () => {
    // risk: resource leak — several running rows must share one timer and release it after completion.
    let now = 1_000;
    let tick: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const cancel = vi.fn();
    const clock = new ToolStepClock(() => now, schedule as any, cancel as any);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = clock.subscribe(first);
    const stopSecond = clock.subscribe(second);

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1_000);
    now += 60_000;
    tick?.();
    expect(first).toHaveBeenLastCalledWith(61_000);
    expect(second).toHaveBeenLastCalledWith(61_000);
    stopFirst();
    expect(cancel).not.toHaveBeenCalled();
    stopSecond();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('selects the latest unfinished root or sub-agent tool step and clears it on its result', () => {
    // risk: user-visible silence — the status line must prefer the newest still-running step across the whole thread tree.
    const clock = new ToolStepClock(() => 5_000);
    const parentStart = toolEvent({ key: 'parent-start', correlationId: 'parent-step', observedAt: 1_000 });
    const workerStart = toolEvent({ key: 'worker-start', threadId: 'parent', agentId: 'job-1:0', agentName: 'Worker',
      correlationId: 'worker-step', observedAt: 2_000, role: 'worker' });
    const statusNoise = toolEvent({ key: 'worker-status', threadId: 'parent', agentId: 'job-1:0', agentName: 'Worker',
      correlationId: undefined, phase: undefined, observedAt: 2_000, role: 'worker', text: 'Worker is alive' });
    const parentResult = toolEvent({ key: 'parent-result', correlationId: 'parent-step', observedAt: 3_000, phase: 'result' });

    clock.observe([workerStart, statusNoise, parentStart]);
    expect(clock.currentStep('parent')).toEqual(workerStart);

    clock.observe([parentResult]);
    expect(clock.currentStep('parent')).toEqual(workerStart);

    const workerResult = { ...workerStart, key: 'worker-result', phase: 'result' as const, observedAt: 4_000 };
    clock.observe([workerResult]);
    expect(clock.currentStep('parent')).toBeNull();
  });

  it('clears active steps when an agent row becomes terminal', () => {
    // risk: false status — stopped workers and lost results must not leave an eternal running indicator.
    const clock = new ToolStepClock(() => 2_000);
    const start = toolEvent({ startedAt: 1_000 });
    clock.observe([start]);
    expect(clock.currentStep('parent')).toEqual(start);

    clock.observe([toolEvent({ key: 'worker-terminal', agentTerminal: true, phase: undefined, correlationId: undefined, observedAt: 1_500 })]);
    expect(clock.currentStep('parent')).toBeNull();
  });

  it('expires active steps past the safety ceiling', () => {
    // risk: false status — a missing/coalesced result must not leave an eternal running indicator.
    const expiredClock = new ToolStepClock(() => ToolStepClock.maximumRunningMs + 1_001);
    expiredClock.observe([toolEvent({ startedAt: 1_000 })]);
    expect(expiredClock.currentStep('parent')).toBeNull();
  });

  it('lets needs-you or failed urgency supersede a running tool step', () => {
    // risk: blocked work — a live tool timer must not hide a user decision or a failed-agent alert.
    const clock = new ToolStepClock(() => 2_000);
    clock.observe([toolEvent({ startedAt: 1_000 })]);
    const urgent = toolEvent({ key: 'needs-human', phase: undefined, correlationId: undefined, urgency: 'needs-you', text: 'Choose an option' });

    expect(clock.selectDisplayItem('parent', urgent, null)).toEqual({ item: urgent, toolStep: false, urgent: true });
  });
});
