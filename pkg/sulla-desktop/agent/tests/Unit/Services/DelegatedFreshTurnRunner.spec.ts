// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { DelegatedFreshTurnRunner, type DelegatedFreshTurnPorts } from '../../../services/DelegatedFreshTurnRunner';

type TurnEffect = (state: any) => void;

/** In-memory job store and graph double; only the model turn itself is faked. */
class FakeDelegatedTask {
  readonly state: any;
  readonly job: any = { id: 'job-e1', tasks: [{ status: 'running', emptyWakeCount: 0 }] };
  readonly calls: string[] = [];
  readonly rerouted: any[] = [];
  readonly acknowledged: any[] = [];
  liveChildren = 0;
  waiting = false;
  executions = 0;
  private clock = 1_000;

  constructor(messages: any[], private readonly effects: TurnEffect[]) {
    this.state = { messages, metadata: { lastActivityMs: 500 } };
  }

  /** A model/tool event inside the graph stamps activity the way BaseNode/ToolExecutor do. */
  touch(state: any): void { state.metadata.lastActivityMs = ++this.clock }

  ports(): DelegatedFreshTurnPorts {
    return {
      jobId:     'job-e1',
      taskIndex: 0,
      threadId:  'thread-e1',
      state:     this.state,
      prepare:   () => { this.calls.push('prepare') },
      execute:   async() => {
        const effect = this.effects[this.executions++] ?? (() => undefined);
        effect(this.state);
        return this.state;
      },
      returnedTask:  async() => undefined,
      getJob:        async() => this.job,
      openChildren:  async() => this.liveChildren,
      pendingWait:   async() => (this.waiting ? { id: 'wait' } : undefined),
      updateJobTask: async(_jobId, index, patch) => { Object.assign(this.job.tasks[index], patch) },
      endWakeTurn:   async() => { this.calls.push('endWakeTurn') },
      waitForWake:   async() => { this.calls.push('waitForWake'); this.liveChildren = 0 },
      resume:        async() => { this.calls.push('resume') },
      rerouteCompletions:     async(_job, _index, reason, entries) => { this.rerouted.push({ reason, entries }) },
      acknowledgeCompletions: async(wakeInput) => { this.acknowledged.push(wakeInput) },
    };
  }
}

const history = () => [
  { role: 'user', content: 'brief' },
  { role: 'assistant', content: 'launched workers' },
];
const reminder = () => ({ role: 'user', content: '[Return contract reminder] ...' });
const completionWake = () => ({
  role: 'user', content: 'child finished',
  metadata: { source: 'sub_agent_completion', completionEntries: [{ jobId: 'child-1', taskIndex: 0 }] },
});

describe('DelegatedFreshTurnRunner', () => {
  it('does not fail a manager whose reminder/ordinary turn was empty with nothing to consume (E1 unknown_wake)', async() => {
    // risk: lost manager job. Reproduces agent-job-1794814360813-2: wake=unknown_wake,
    // unconsumedCompletionJobs=none, no live children, no pending wait -> the old loop threw.
    const task = new FakeDelegatedTask([...history(), reminder()], []);
    const result = await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(result.returned).toBeUndefined();
    expect(task.executions).toBe(2); // the one retry still happens
    expect(task.job.tasks[0].emptyWakeCount).toBe(1); // bounded across turns
    expect(task.rerouted).toEqual([]);
  });

  it('counts a tool-only CLI turn as progress even though no assistant message was stored', async() => {
    // risk: false failure. Claude Code runs tools inside the provider and a [SILENT]
    // reply stores no visible assistant text, so the message count never grows.
    const task = new FakeDelegatedTask([...history(), completionWake()], [state => task.touch(state)]);
    task.job.tasks[0].emptyWakeCount = 2;
    const result = await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(result.returned).toBeUndefined();
    expect(task.executions).toBe(1); // no needless retry
    expect(task.job.tasks[0].emptyWakeCount).toBe(0); // progress resets the empty counter
    expect(task.acknowledged).toHaveLength(1); // completions marked delivered, not rerouted
    expect(task.rerouted).toEqual([]);
  });

  it('counts a new assistant reply as progress after context trimming shrank the history', async() => {
    // risk: false failure. Token-budget trimming replaces state.messages, so the
    // assistant count can stay equal even though the model answered.
    const task = new FakeDelegatedTask([...history(), completionWake()], [state => {
      state.messages = [state.messages[state.messages.length - 1], { role: 'assistant', content: 'reviewed child result' }];
    }]);
    await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(task.executions).toBe(1);
    expect(task.rerouted).toEqual([]);
  });

  it('still fails and reroutes child completions when a truly empty turn would strand them', async() => {
    // risk: lost delegated work. Nothing will wake the manager again, so its
    // children's results must be rerouted rather than silently dropped.
    const task = new FakeDelegatedTask([...history(), completionWake()], []);
    await expect(new DelegatedFreshTurnRunner(task.ports()).run(task.state))
      .rejects.toThrow('wake=sub_agent_completion, unconsumedCompletionJobs=child-1');
    expect(task.rerouted).toHaveLength(1);
    expect(task.acknowledged).toEqual([]);
  });

  it('parks a truly empty wake while a child is live and runs again when woken', async() => {
    // risk: lost manager job while workers are still running
    const task = new FakeDelegatedTask([...history(), completionWake()], [() => undefined, () => undefined, state => task.touch(state)]);
    task.liveChildren = 1;
    await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(task.calls).toEqual(expect.arrayContaining(['endWakeTurn', 'waitForWake', 'resume']));
    expect(task.executions).toBe(3);
    expect(task.job.tasks[0].emptyWakeCount).toBe(0);
  });

  it('fails once truly empty turns repeat past the bound, even with nothing to consume', async() => {
    // risk: a dead provider loops a manager forever
    const task = new FakeDelegatedTask([...history(), reminder()], []);
    task.job.tasks[0].emptyWakeCount = 2;
    await expect(new DelegatedFreshTurnRunner(task.ports()).run(task.state))
      .rejects.toThrow('wake=unknown_wake, unconsumedCompletionJobs=none');
  });
});
