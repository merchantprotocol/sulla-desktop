// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { expect, it } from 'vitest';

import { ProviderToolTranscript, ProviderToolTranscriptSink, type ProviderToolTranscriptSinkPort } from '@pkg/agent/nodes/ProviderToolTranscript';

class RecordingSink implements ProviderToolTranscriptSinkPort {
  readonly events: unknown[][] = [];
  private releaseCall: () => void = () => {};
  readonly callGate = new Promise<void>(resolve => { this.releaseCall = resolve });

  async emitCall(toolUseId: string, toolName: string, input: unknown, kind?: 'provider'): Promise<boolean> {
    await this.callGate;
    this.events.push(['call', toolUseId, toolName, input, kind]);
    return true;
  }

  async emitResult(toolUseId: string, success: boolean, error: string | undefined, result: unknown): Promise<boolean> {
    this.events.push(['result', toolUseId, success, error, result]);
    return true;
  }

  log(toolName: string, input: unknown, result: unknown, toolUseId: string): void { this.events.push(['log', toolUseId, toolName, input, result]) }
  warn(): void {}
  release(): void { this.releaseCall() }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function transcript(sink: RecordingSink, runId = 'run'): ProviderToolTranscript {
  return new ProviderToolTranscript(new ProviderToolTranscriptSink(runId,
    (id, name, input, kind) => sink.emitCall(id, name, input, kind),
    (id, success, error, result) => sink.emitResult(id, success, error, result),
    (name, input, result, id) => sink.log(name, input, result, id),
    (message, error) => sink.warn(message, error)));
}

// risk: data accuracy — a provider-CLI tool's full input, output and stderr must reach chat, call before result.
it('forwards the complete provider tool call and its failing result in order', async() => {
  const sink = new RecordingSink();
  const trace = transcript(sink);
  const input = { command: `npm test ${ 'x'.repeat(2_000) }` };
  const output = `OUT:${ 'y'.repeat(60_000) }`;

  trace.started({ toolUseId: 'cli-1', toolName: 'command_execution', input });
  trace.finished({ toolUseId: 'cli-1', toolName: 'command_execution', input, result: output, error: 'STDERR: boom', isError: true });
  sink.release();
  await settle();

  expect(sink.events[0]).toEqual(['log', expect.stringMatching(/^run-[\w.-]+-cli-1$/), 'command_execution', input, { result: output, error: 'STDERR: boom' }]);
  expect(sink.events[1]).toEqual(['call', sink.events[0][1], 'command_execution', input, 'provider']);
  expect(sink.events[2]).toEqual(['result', sink.events[0][1], false, 'STDERR: boom', output]);
});

// risk: lost evidence — a result with no observed start still gets its call row first, exactly once.
it('emits the call for a result whose start was never seen, and reports success', async() => {
  const sink = new RecordingSink();
  sink.release();
  const trace = transcript(sink);

  trace.finished({ toolUseId: 'cli-2', toolName: 'Read', input: { path: '/a' }, result: 'file body' });
  await settle();

  expect(sink.events.filter(event => event[0] !== 'log')).toEqual([
    ['call', expect.stringMatching(/^run-[\w.-]+-cli-2$/), 'Read', { path: '/a' }, 'provider'],
    ['result', sink.events[0][1], true, undefined, 'file body'],
  ]);
});

// risk: transcript accuracy — provider-local item_0 ids collide when a turn is interrupted and the next turn reuses the id.
it('scopes item_0 per turn and emits an interrupted result for the abandoned call', async() => {
  const firstSink = new RecordingSink();
  const secondSink = new RecordingSink();
  firstSink.release();
  secondSink.release();
  const first = transcript(firstSink);
  const second = transcript(secondSink);
  first.started({ toolUseId: 'item_0', toolName: 'command_execution', input: { command: 'first' } });
  await first.interrupted();
  second.started({ toolUseId: 'item_0', toolName: 'command_execution', input: { command: 'second' } });
  second.finished({ toolUseId: 'item_0', toolName: 'command_execution', result: 'SECOND_FULL_RESULT' });
  await settle();

  const firstCall = firstSink.events.find(event => event[0] === 'call')!;
  const firstResult = firstSink.events.find(event => event[0] === 'result')!;
  const secondCall = secondSink.events.find(event => event[0] === 'call')!;
  const secondResult = secondSink.events.find(event => event[0] === 'result')!;
  expect(firstCall[1]).not.toBe(secondCall[1]);
  expect(firstResult).toEqual(['result', firstCall[1], false, 'interrupted', undefined]);
  expect(secondResult).toEqual(['result', secondCall[1], true, undefined, 'SECOND_FULL_RESULT']);
});
