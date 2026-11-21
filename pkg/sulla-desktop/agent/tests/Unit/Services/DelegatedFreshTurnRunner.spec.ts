// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { DeferredStallInput } from '../../../app/Services/DeferredStallInput';
import type { PendingCompletion } from '../../../services/AgentCompletionInbox';
import { DelegatedFreshTurnRunner, type DelegatedFreshTurnPorts } from '../../../services/DelegatedFreshTurnRunner';
import { TurnOutputCounter } from '../../../services/TurnOutputCounter';

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

  /**
   * What BaseNode does on EVERY model call, output or not: "Preparing your
   * turn…" onActivity, the streaming_complete/thinking_complete sentinels and
   * blank separator tokens all stamp the activity timestamps.
   */
  heartbeat(state: any): void {
    state.metadata.lastActivityMs = ++this.clock;
    state.metadata.lastAgentActivityAt = ++this.clock;
    new TurnOutputCounter(state.metadata).recordToken('\n\n');
    new TurnOutputCounter(state.metadata).recordToken('');
  }

  /** A provider-managed (Claude Code/Codex CLI) tool call: BaseNode.onToolEvent. */
  cliToolCall(state: any): void {
    this.heartbeat(state);
    new TurnOutputCounter(state.metadata).record();
  }

  /** BaseNode.appendResponse: store a non-blank reply and count it as output. */
  reply(state: any, content: string): void {
    this.heartbeat(state);
    state.messages.push({ role: 'assistant', content });
    new TurnOutputCounter(state.metadata).record();
  }

  /** ToolExecutor: store a tool result and count the batch as output. */
  toolResult(state: any): void {
    this.heartbeat(state);
    state.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], metadata: { kind: 'tool_result' } });
    new TurnOutputCounter(state.metadata).record();
  }

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
    const task = new FakeDelegatedTask([...history(), completionWake()], [state => task.cliToolCall(state)]);
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
      state.messages = [state.messages[state.messages.length - 1]];
      task.reply(state, 'reviewed child result');
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
    const task = new FakeDelegatedTask([...history(), completionWake()], [() => undefined, () => undefined, state => task.cliToolCall(state)]);
    task.liveChildren = 1;
    await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(task.calls).toEqual(expect.arrayContaining(['endWakeTurn', 'waitForWake', 'resume']));
    expect(task.executions).toBe(3);
    expect(task.job.tasks[0].emptyWakeCount).toBe(0);
  });

  it('treats a turn that only stamped activity timestamps as empty and reroutes stranded completions', async() => {
    // risk: lost delegated work. Production stamps lastActivityMs/lastAgentActivityAt
    // on every model call even with no output; that must not ACK child completions.
    const task = new FakeDelegatedTask([...history(), completionWake()], [
      state => task.heartbeat(state),
      state => task.heartbeat(state),
    ]);
    await expect(new DelegatedFreshTurnRunner(task.ports()).run(task.state))
      .rejects.toThrow('wake=sub_agent_completion, unconsumedCompletionJobs=child-1');

    expect(task.executions).toBe(2); // the empty turn was retried
    expect(task.rerouted).toHaveLength(1);
    expect(task.acknowledged).toEqual([]);
  });

  it('settles a heartbeat-only reminder turn instead of counting it as progress', async() => {
    // risk: unbounded empty loop. A heartbeat must advance the empty-wake bound.
    const task = new FakeDelegatedTask([...history(), reminder()], [
      state => task.heartbeat(state),
      state => {
        task.heartbeat(state);
        state.messages.push({ role: 'assistant', content: 'Error: LLM returned empty response', metadata: { kind: 'agent_error' } });
        state.messages.push({ role: 'assistant', content: '   ' });
      },
    ]);
    task.job.tasks[0].emptyWakeCount = 1;
    const result = await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(result.returned).toBeUndefined();
    expect(task.executions).toBe(2);
    expect(task.job.tasks[0].emptyWakeCount).toBe(2);
  });

  it('counts a Sulla tool result as progress even when the model wrote no text', async() => {
    // risk: false failure for a tool-only turn on the non-CLI path
    const task = new FakeDelegatedTask([...history(), completionWake()], [state => task.toolResult(state)]);
    await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(task.executions).toBe(1);
    expect(task.acknowledged).toHaveLength(1);
    expect(task.rerouted).toEqual([]);
  });

  it('does not count history rewritten as JSON-cloned copies as progress (no false ACK)', async() => {
    // risk: lost delegated work. SubconsciousMiddleware.applyPendingBackground splices
    // JSON-cloned snapshot messages into state.messages at the start of every turn, so
    // old assistant/tool messages become new objects. An empty wake turn must still
    // reroute the child completions instead of marking them delivered unread.
    const rewrite = (state: any) => {
      task.heartbeat(state);
      state.messages = JSON.parse(JSON.stringify(state.messages));
    };
    const task = new FakeDelegatedTask([
      ...history(),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }], metadata: { kind: 'tool_result' } },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'spawn', input: {} }] },
      completionWake(),
    ], [rewrite, rewrite]);
    await expect(new DelegatedFreshTurnRunner(task.ports()).run(task.state))
      .rejects.toThrow('wake=sub_agent_completion, unconsumedCompletionJobs=child-1');

    expect(task.executions).toBe(2);
    expect(task.rerouted).toHaveLength(1);
    expect(task.acknowledged).toEqual([]);
  });

  it('fails once truly empty turns repeat past the bound, even with nothing to consume', async() => {
    // risk: a dead provider loops a manager forever
    const task = new FakeDelegatedTask([...history(), reminder()], []);
    task.job.tasks[0].emptyWakeCount = 2;
    await expect(new DelegatedFreshTurnRunner(task.ports()).run(task.state))
      .rejects.toThrow('wake=unknown_wake, unconsumedCompletionJobs=none');
  });
  it('passes only a genuine completion with display notice to the delegated delivery callback', async() => {
    // risk: stamping the running child's durable completion and losing its eventual return
    const advisory: PendingCompletion = { jobId: 'running', taskIndex: 1, noticeKind: 'stall', results: [] };
    const returned: PendingCompletion = { jobId: 'completed', taskIndex: 2, results: [], notice: '[re-delivery] result' };
    const wake = completionWake();
    wake.metadata.completionEntries = [advisory, returned];
    const task = new FakeDelegatedTask([...history(), wake], [state => task.reply(state, 'reviewed')]);

    await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(task.acknowledged).toEqual([[returned]]);
  });

  it.each([0, 2])('does not fail, reroute, acknowledge or spend an empty wake on a stall-only turn at count %s', async(count) => {
    // risk: an advisory falsely fails a parent or mutates child delivery bookkeeping
    const stall: PendingCompletion = { jobId: 'running', taskIndex: 1, noticeKind: 'stall', results: [] };
    const wake = { role: 'user', content: '', metadata: DeferredStallInput.metadata('manager', 'thread-e1', [stall]) };
    const task = new FakeDelegatedTask([...history(), wake], []);
    task.job.tasks[0].emptyWakeCount = count;
    const result = await new DelegatedFreshTurnRunner(task.ports()).run(task.state);

    expect(result.returned).toBeUndefined();
    expect(task.rerouted).toEqual([]);
    expect(task.acknowledged).toEqual([]);
    expect(task.job.tasks[0].emptyWakeCount).toBe(count);
  });

});
