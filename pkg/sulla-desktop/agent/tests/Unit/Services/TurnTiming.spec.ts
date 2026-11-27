// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { SafeToolLabel, TurnTiming, TurnTimingDispatchContext, TurnTimingDispatchLifecycle, TurnTimingOutcomePolicy } from '../../../services/TurnTiming';
import type { TurnTimingOutcome } from '../../../services/TurnTiming';

class ManualClock {
  constructor(private value: number) {}
  epochNow(): number { return this.value; }
  now(): number { return this.value; }
  advance(ms: number): void { this.value += ms; }
}

class RecordingPerfLog {
  readonly lines: string[] = [];
  log(line: string): void { this.lines.push(line); }
  record(): Record<string, any> { return JSON.parse(this.lines[0].replace(/^\[TurnTiming\] /, '')); }
}

function createTiming(clock: ManualClock, log: RecordingPerfLog, runId = 'run-1', threadId = 'thread-1'): TurnTiming {
  return new TurnTiming({
    clock,
    perfLog: log,
    runId,
    surface: 'chat',
    provider: 'codex',
    model: 'gpt-test',
    threadId,
  });
}

describe('TurnTiming', () => {
  it('writes one turn-relative correlated record across requests and tool steps', () => {
    // risk: timing phases attach to the wrong request/turn or use wall-clock instead of relative durations
    const clock = new ManualClock(1_000);
    const log = new RecordingPerfLog();
    const timing = createTiming(clock, log);
    timing.setQueueWaitMs(12);
    clock.advance(12);
    timing.markPreModelEnd();
    clock.advance(5);
    timing.beginProviderRequest('bridge-1');
    clock.advance(7);
    timing.markFirstByte('bridge-1');
    clock.advance(3);
    timing.markFirstText('bridge-1');
    clock.advance(2);
    timing.endProviderRequest('bridge-1', 200, 44);
    clock.advance(4);
    timing.beginToolStep('step-1', 'git -C /private/project status --porcelain', 'codex_cli');
    clock.advance(9);
    timing.endToolStep('step-1', true);
    timing.addReasoning(6);
    timing.markFirstVisibleText();
    timing.finish('ok');
    clock.advance(100);
    timing.finish('error');

    expect(log.lines).toHaveLength(1);
    expect(log.record()).toMatchObject({
      schemaVersion: 1,
      runId: 'run-1',
      outcome: 'ok',
      threadId: 'thread-1',
      startedAtMs: 1_000,
      queueWaitMs: 12,
      preModelMs: 0,
      firstVisibleTextMs: 42,
      reasoningMs: 6,
      totalMs: 42,
      providerRequests: [{
        bridgeRequestId: 'bridge-1', startMs: 17, firstByteMs: 24, firstTextMs: 27, endMs: 29, status: 200, bodyBytes: 44,
      }],
      toolSteps: [{ name: 'git', source: 'codex_cli', startMs: 33, endMs: 42, durationMs: 9, ok: true }],
    });
    expect(log.lines[0]).not.toContain('/private/project');
  });

  it('uses the exact supplied epoch samples for tool span boundaries', () => {
    // risk: live progress rows and final perf spans disagree because each samples a different timestamp
    const clock = new ManualClock(1_000);
    const log = new RecordingPerfLog();
    const timing = createTiming(clock, log);
    timing.beginToolStep('step-exact', 'npx test', 'codex_cli', 1_025);
    clock.advance(10);
    timing.endToolStep('step-exact', true, 1_055);
    clock.advance(10);
    timing.finish('ok');

    expect(log.record().toolSteps).toMatchObject([
      { name: 'npx', startMs: 25, endMs: 55, durationMs: 30, ok: true },
    ]);
  });

  it.each<TurnTimingOutcome>(['ok', 'error', 'aborted'])('flushes exactly once for %s settlement', (outcome) => {
    // risk: error/abort settlement drops a turn record or writes duplicate records during cleanup
    const clock = new ManualClock(30);
    const log = new RecordingPerfLog();
    const timing = createTiming(clock, log);
    timing.beginProviderRequest('bridge-open');
    timing.beginToolStep('step-open', 'git status /private/repo', 'native');
    clock.advance(10);
    timing.finish(outcome);
    timing.finish(outcome === 'ok' ? 'error' : 'ok');
    expect(log.lines).toHaveLength(1);
    expect(log.record().outcome).toBe(outcome);
    expect(log.record().providerRequests).toMatchObject([{ bridgeRequestId: 'bridge-open', endMs: 10, status: null }]);
    expect(log.record().toolSteps).toMatchObject([{ name: 'git', endMs: 10, durationMs: 10, ok: null }]);
  });

  it('keeps concurrent turn requests and tools isolated by instance and run id', () => {
    // risk: concurrent threads contaminate each other’s request or tool timing
    const clock = new ManualClock(50);
    const firstLog = new RecordingPerfLog();
    const secondLog = new RecordingPerfLog();
    const first = createTiming(clock, firstLog, 'run-a', 'thread-a');
    const second = createTiming(clock, secondLog, 'run-b', 'thread-b');
    first.beginProviderRequest('bridge-a');
    second.beginProviderRequest('bridge-b');
    clock.advance(8);
    first.markFirstByte('bridge-a');
    second.beginToolStep('step-b', 'sulla files/search {"query":"/private"}', 'mcp');
    first.finish('ok');
    second.finish('aborted');

    expect(firstLog.record()).toMatchObject({ runId: 'run-a', threadId: 'thread-a', providerRequests: [{ bridgeRequestId: 'bridge-a', firstByteMs: 8 }], toolSteps: [] });
    expect(secondLog.record()).toMatchObject({ runId: 'run-b', threadId: 'thread-b', providerRequests: [{ bridgeRequestId: 'bridge-b', firstByteMs: null }], toolSteps: [{ name: 'sulla files/search' }] });
    expect(secondLog.lines[0]).not.toContain('/private');
  });

  it('drops excess tool steps and counts truncation without exposing arguments', () => {
    // risk: an unusually long tool loop grows perf records without bound or leaks raw commands
    const log = new RecordingPerfLog();
    const timing = createTiming(new ManualClock(0), log);
    for (let i = 0; i < 501; i++) timing.beginToolStep(`step-${ i }`, `grep secret /private/${ i }`, 'native');
    timing.finish('ok');
    expect(log.record().toolSteps).toHaveLength(500);
    expect(log.record().truncatedSteps).toBe(1);
    expect(log.lines[0]).not.toContain('secret');
    expect(log.lines[0]).not.toContain('/private');
  });
});

describe('SafeToolLabel', () => {
  it.each([
    ['KEY=secret npx foo', 'shell', ['secret']],
    ['OPENAI_API_KEY=sk-abc123 npx foo', 'shell', ['sk-abc123', 'abc123']],
    ['git=secret', 'shell', ['secret']],
    ['env KEY=secret npx foo', 'shell', ['secret']],
    ['sudo git status', 'shell', []],
    ['time git status', 'shell', []],
    ['nohup git status', 'shell', []],
    ['nice git status', 'shell', []],
    ['command git status', 'shell', []],
    ['exec git status', 'shell', []],
    ['xargs git status', 'shell', []],
    ['timeout 4 git status', 'shell', []],
    ['doas git status', 'shell', []],
    ['git status | cat secret', 'shell', ['secret']],
    ['git status && cat sk-abc123', 'shell', ['sk-abc123']],
    ['git status || cat secret', 'shell', ['secret']],
    ['git status; echo secret', 'shell', ['secret']],
    ['git > /tmp/sk-abc123', 'shell', ['sk-abc123']],
    ['git < /tmp/secret', 'shell', ['secret']],
    ['git $(echo secret)', 'shell', ['secret']],
    ['git `echo sk-abc123`', 'shell', ['sk-abc123']],
    ['git (secret)', 'shell', ['secret']],
    ['git {secret}', 'shell', ['secret']],
    ['$(echo secret) npx foo', 'shell', ['secret']],
    ['`echo sk-abc123` npx foo', 'shell', ['sk-abc123']],
    ['(git status)', 'shell', []],
    ['{ git status; }', 'shell', []],
    ['{git}', 'shell', []],
    ["git 'secret'", 'shell', ['secret']],
    ['git "secret"', 'shell', ['secret']],
    ['./secret/bin/git status', 'shell', ['secret']],
    ['/usr/bin/git -C /private/repo status', 'shell', []],
    ['/tmp/sk-abc123', 'shell', ['sk-abc123']],
    ['git status', 'git', []],
    ['npx test', 'npx', []],
    ['sulla files/search {"query":"/Users/example/private"}', 'sulla files/search', ['/Users/example/private']],
    ['sulla ../private/secrets token', 'sulla', ['/private/secrets']],
    ['Read /private/secrets.txt', 'Read', ['/private/secrets.txt']],
  ] as Array<[string, string, string[]]>)('labels %s as %s without exposing sensitive values', (value, expected, sensitiveValues) => {
    // risk: shell parsing leaks secrets from assignments/arguments into timing and chat logs
    const label = SafeToolLabel.from(value);
    expect(label).toBe(expected);
    for (const sensitiveValue of sensitiveValues) expect(label).not.toContain(sensitiveValue);
  });

  it('uses a generic label for empty or non-string values', () => {
    expect(SafeToolLabel.from('   ')).toBe('tool');
    expect(SafeToolLabel.from(undefined)).toBe('tool');
  });
});

describe('turn dispatch lifecycle', () => {
  function createLifecycle(signal: AbortSignal) {
    const clock = new ManualClock(500);
    const log = new RecordingPerfLog();
    const timing = createTiming(clock, log, 'run-dispatch', 'thread-dispatch');
    const state: { metadata: { options: { abort: { signal: AbortSignal } } }; __turnTiming?: TurnTiming } = {
      metadata: { options: { abort: { signal } } },
    };
    Object.defineProperty(state, '__turnTiming', { value: timing, configurable: true, enumerable: false });
    const lifecycle = new TurnTimingDispatchLifecycle(timing, state);
    return { graph: { execute: async() => undefined as unknown }, lifecycle, log, state };
  }

  it('records one ok record and removes its runtime timing context after graph dispatch', async() => {
    // risk: a successful dispatch loses or duplicates its per-turn timing record or leaves a stale sink attached
    const controller = new AbortController();
    const { graph, lifecycle, log, state } = createLifecycle(controller.signal);
    const execute = vi.fn(async() => 'done');
    graph.execute = execute;

    await lifecycle.executeGraph(() => graph.execute(), controller.signal);
    lifecycle.finish();

    expect(execute).toHaveBeenCalledOnce();
    expect(log.lines).toHaveLength(1);
    expect(log.record()).toMatchObject({ runId: 'run-dispatch', outcome: 'ok' });
    expect(state.__turnTiming).toBeUndefined();
  });

  it('records one error record when graph dispatch throws and removes its runtime timing context', async() => {
    // risk: a graph error is recorded as success or cleanup leaves a failed turn's timing sink attached
    const controller = new AbortController();
    const { graph, lifecycle, log, state } = createLifecycle(controller.signal);
    const execute = vi.fn(async() => { throw new Error('synthetic graph failure'); });
    graph.execute = execute;

    await expect(lifecycle.executeGraph(() => graph.execute(), controller.signal)).rejects.toThrow('synthetic graph failure');
    lifecycle.finish();

    expect(execute).toHaveBeenCalledOnce();
    expect(log.lines).toHaveLength(1);
    expect(log.record()).toMatchObject({ runId: 'run-dispatch', outcome: 'error' });
    expect(state.__turnTiming).toBeUndefined();
  });

  it('records an abort when graph handles Stop and returns normally', async() => {
    // risk: Graph.execute swallows AbortError, causing a user-stopped turn to be logged as ok
    const controller = new AbortController();
    const { graph, lifecycle, log, state } = createLifecycle(controller.signal);
    const execute = vi.fn(async() => {
      controller.abort(); // mirrors Graph.execute catching AbortError after Stop
      return undefined;
    });
    graph.execute = execute;

    await lifecycle.executeGraph(() => graph.execute(), controller.signal);
    lifecycle.finish();

    expect(execute).toHaveBeenCalledOnce();
    expect(log.lines).toHaveLength(1);
    expect(log.record()).toMatchObject({ runId: 'run-dispatch', outcome: 'aborted' });
    expect(state.__turnTiming).toBeUndefined();
  });

  it('classifies workerModelTask dispatch metadata as delegated', () => {
    // risk: tab-lead and resumed worker runs skew chat p50/p90 because the job id is dropped
    const context = new TurnTimingDispatchContext({ workerModelTask: { jobId: 'job-tab-lead', taskIndex: 3 } }, 'sulla-desktop', 'sulla-desktop', 'heartbeat');
    const log = new RecordingPerfLog();
    new TurnTiming({
      clock: new ManualClock(700),
      perfLog: log,
      runId: 'run-tab-lead',
      surface: context.surface,
      provider: 'codex',
      model: null,
      threadId: 'thread-tab-lead',
      jobId: context.jobId,
      taskIndex: context.taskIndex,
    }).finish('ok');

    expect(log.record()).toMatchObject({ surface: 'delegated', jobId: 'job-tab-lead', taskIndex: 3 });
  });

  it('records stopped delegated tasks as aborted rather than successful', () => {
    // risk: stopped delegated work inflates successful turn counts
    expect(TurnTimingOutcomePolicy.forDelegatedResult('stopped')).toBe('aborted');
    expect(TurnTimingOutcomePolicy.forDelegatedResult('error')).toBe('error');
    expect(TurnTimingOutcomePolicy.forDelegatedResult('completed')).toBe('ok');
  });
});
