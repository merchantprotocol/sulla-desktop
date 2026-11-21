// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later


import { describe, expect, it } from 'vitest';
import { AgentCompletionInboxService, type PendingCompletion } from '../../../app/Services/AgentCompletionInboxService';
import { AgentRuntimeLiveness } from '../../../app/Services/AgentRuntimeLiveness';
import { AgentStateProjector, type AgentTaskCheckin } from '../../../app/Services/AgentStateProjector';
import { AgentTaskActivityProjector } from '../../../app/Services/AgentTaskActivityProjector';
import { CompletionAcknowledgementService } from '../../../app/Services/CompletionAcknowledgementService';
import { CompletionFormatter } from '../../../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../../../app/Services/CompletionIdleDispatcher';
import { CompletionKey } from '../../../app/Services/CompletionKey';
import { DelegatedCompletionHandoff } from '../../../app/Services/DelegatedCompletionHandoff';
import { ParentStallNoticeService } from '../../../app/Services/ParentStallNoticeService';
import type { AgentStateService } from '../../../app/Services/AgentStateService';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

class StallHarness {
  now = 301_000;
  readonly activity = new Map<string, number>();
  readonly tools = new Map<string, { name: string; startedAt: number }>();
  readonly decisions = new Set<string>();
  readonly checkins: Record<number, { latestCheckin: AgentTaskCheckin }> = {};
  readonly runtime = new AgentRuntimeLiveness(() => this.now);
  readonly inbox = new AgentCompletionInboxService(new CompletionIdleDispatcher(), new CompletionFormatter(10_000));
  readonly child: AgentJob = {
    jobId: 'child', parentJobId: 'middle', parentTaskIndex: 1, parentChannel: 'manager-channel',
    parentThreadId: 'middle-task-1', createdAt: 1_000, finishedAt: null, status: 'running',
    taskCount: 2, tasks: [this.task('child-0'), this.task('child-1')], results: [], visibility: 'hidden',
  };
  readonly scanner: ParentStallNoticeService;
  readonly marks: string[] = [];
  readonly acknowledgements = new CompletionAcknowledgementService({
    markTaskCompletionDelivered: async(job, index) => { this.marks.push(`delivered:${ job }:${ index }`) },
    releaseTaskCompletion: async(job, index) => { this.marks.push(`released:${ job }:${ index }`) },
  }, {} as never, this.inbox);

  constructor(observedSince = 1_000) {
    const clock = () => this.now;
    const activity = new AgentTaskActivityProjector({
      lastActivityAt: key => this.activity.get(key), toolInFlight: key => this.tools.get(key),
    }, clock);
    const projector = new AgentStateProjector({} as AgentStateService,
      { latest: async() => null }, clock, {}, activity, this.runtime, observedSince);
    this.scanner = new ParentStallNoticeService({
      jobs: async() => [structuredClone(this.child)],
      job: async() => structuredClone(this.child),
      telemetry: async() => ({ child: structuredClone(this.checkins) }),
      waitingForDecision: async thread => this.decisions.has(thread),
    }, projector, this.inbox);
    this.inbox.registerStallValidator((...args) => this.scanner.canDeliver(...args));
    this.activity.set('child#1', this.now);
  }

  private task(threadId: string): AgentJobTask {
    return { agentId: 'worker', label: threadId, threadId, status: 'running', startedAt: 1_000, prompt: 'work' };
  }

  take() { return this.inbox.take('manager-channel', 'middle-task-1') }

  async current(entries: PendingCompletion[]) { return this.inbox.currentEntries('manager-channel', 'middle-task-1', entries) }
}

describe('immediate-parent stall delivery', () => {
  it.each([false, undefined, true])('uses the exact five-minute threshold with probe %s', async(probe) => {
    // risk: waking a manager early or treating a known-running worker as stalled
    const h = new StallHarness();
    h.now--;
    h.runtime.record('child-0', probe);
    await h.scanner.scan();
    expect(h.take()).toEqual([]);
    h.now++;
    await h.scanner.scan();
    expect(h.take().map(entry => entry.taskIndex)).toEqual(probe === true ? [] : [0]);
  });

  it.each(['boot grace', 'timer', 'parked', 'decision', 'blocker', 'in-flight tool', 'no parent channel'])('does not wake for %s', async(reason) => {
    // risk: false escalation for genuine waits or routing to a fallback parent
    const h = new StallHarness(reason === 'boot grace' ? 2_000 : 1_000);
    if (reason === 'timer') h.child.tasks[0].wakeAt = h.now + 1_000;
    if (reason === 'parked') h.child.tasks[0].status = 'parked';
    if (reason === 'decision') h.decisions.add('child-0');
    if (reason === 'blocker') h.checkins[0] = { latestCheckin: { createdAt: 1_000, summary: 'blocked', blockers: ['Needs manager'] } };
    if (reason === 'in-flight tool') h.tools.set('child#0', { name: 'build', startedAt: 1_000 });
    if (reason === 'no parent channel') h.child.parentChannel = undefined;
    await h.scanner.scan();
    expect(h.inbox.pendingCount()).toBe(0);
  });

  it('routes only to the exact nested parent, and deduplicates until recovery and re-stall', async() => {
    // risk: ancestor/sibling disclosure and repeated wakes for one incident
    const h = new StallHarness();
    await h.scanner.scan();
    await h.scanner.scan();
    expect(h.inbox.take('root-channel', 'root')).toEqual([]);
    expect(h.inbox.take('manager-channel', 'middle-task-0')).toEqual([]);
    expect(h.inbox.take('sulla-desktop', 'middle-task-1')).toEqual([]);
    const first = h.take();
    expect(first.map(entry => entry.taskIndex)).toEqual([0]);
    expect(await h.inbox.currentEntries('root-channel', 'root', first)).toEqual([]);
    expect(await h.current(first)).toEqual(first);
    await h.acknowledgements.acknowledge(first[0]);
    h.activity.set('child#0', ++h.now);
    await h.scanner.scan();
    h.now += 300_000;
    h.activity.set('child#1', h.now);
    await h.scanner.scan();
    const second = h.take();
    expect(second.map(entry => entry.taskIndex)).toEqual([0]);
    expect(CompletionKey.of(first[0])).not.toBe(CompletionKey.of(second[0]));
  });

  it.each(['completed', 'error', 'stopped', 'new generation', 'recent activity', 'runtime recovered', 'decision'])('drops a queued stall after %s', async(change) => {
    // risk: a busy parent acts on obsolete status; real same-task settlements must survive
    const h = new StallHarness();
    await h.scanner.scan();
    const task = h.child.tasks[0];
    if (change === 'new generation') task.generation = 2;
    else if (change === 'recent activity') h.activity.set('child#0', h.now);
    else if (change === 'runtime recovered') h.runtime.record('child-0', true);
    else if (change === 'decision') h.decisions.add('child-0');
    else task.status = change as AgentJobTask['status'];
    const terminal: PendingCompletion = { jobId: 'child', taskIndex: 0, results: [],
      ...(change === 'error' ? { failureReason: 'child failed' } : {}) };
    if (change === 'completed' || change === 'error') {
      expect(h.inbox.enqueue('manager-channel', 'middle-task-1', terminal)).toBe(true);
      expect(await h.current(h.take())).toEqual([terminal]);
      await h.acknowledgements.acknowledge(terminal);
      expect(h.marks).toEqual(['delivered:child:0']);
    } else expect(await h.current(h.take())).toEqual([]);
  });

  it.each(['parked', 'busy'])('uses the delegated %s wake without touching terminal delivery bookkeeping', async(parentState) => {
    // risk: a disconnected extra turn, loss of a real result, or a false terminal acknowledgement
    const h = new StallHarness();
    await h.scanner.scan();
    const terminal: PendingCompletion = { jobId: 'other-child', taskIndex: 0, results: [], failureReason: 'failed' };
    h.inbox.enqueue('manager-channel', 'middle-task-1', terminal);
    const state = { messages: [] as { metadata: { completionEntries: PendingCompletion[] } }[],
      metadata: { delegatedRunActive: parentState === 'busy' } };
    const wakes: string[] = [];
    const handoff = new DelegatedCompletionHandoff(h.inbox, {
      hasLiveWaiter: () => parentState === 'parked',
      wake: thread => { wakes.push(thread); return true },
    }, {
      firstDelivered: async entry => { h.marks.push(`first:${ entry.jobId }:${ entry.taskIndex }`) },
      acknowledge: entry => h.acknowledgements.acknowledge(entry),
    }, (target, message) => { target.messages.push(message) }, () => 'steer');
    expect(await handoff.deliver('manager-channel', 'middle-task-1', state)).toBe(true);
    expect(wakes).toEqual(['middle-task-1']);
    const [notice, actualTerminal] = state.messages[0].metadata.completionEntries;
    expect(notice.noticeKind).toBe('stall');
    expect(actualTerminal).toEqual(terminal);
    await h.acknowledgements.release(notice);
    h.inbox.requeueQuietly('manager-channel', 'middle-task-1', notice);
    expect(await h.current(h.take())).toEqual([notice]);
    expect(h.marks).toEqual(['first:other-child:0', 'delivered:other-child:0']);
  });
});
