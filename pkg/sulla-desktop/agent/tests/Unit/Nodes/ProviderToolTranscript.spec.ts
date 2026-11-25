// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { expect, it } from 'vitest';

import { ProviderToolTranscript, type ProviderToolTranscriptSink } from '@pkg/agent/nodes/ProviderToolTranscript';

class RecordingSink implements ProviderToolTranscriptSink {
  readonly events: unknown[][] = [];
  private releaseCall: () => void = () => {};
  readonly callGate = new Promise<void>(resolve => { this.releaseCall = resolve });

  async emitCall(toolUseId: string, toolName: string, input: unknown): Promise<boolean> {
    await this.callGate;
    this.events.push(['call', toolUseId, toolName, input]);
    return true;
  }

  async emitResult(toolUseId: string, success: boolean, error: string | undefined, result: unknown): Promise<boolean> {
    this.events.push(['result', toolUseId, success, error, result]);
    return true;
  }

  log(toolName: string, input: unknown, result: unknown): void { this.events.push(['log', toolName, input, result]) }
  warn(): void {}
  release(): void { this.releaseCall() }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// risk: data accuracy — a provider-CLI tool's full input, output and stderr must reach chat, call before result.
it('forwards the complete provider tool call and its failing result in order', async() => {
  const sink = new RecordingSink();
  const transcript = new ProviderToolTranscript(sink);
  const input = { command: `npm test ${ 'x'.repeat(2_000) }` };
  const output = `OUT:${ 'y'.repeat(60_000) }`;

  transcript.started({ toolUseId: 'cli-1', toolName: 'command_execution', input });
  transcript.finished({ toolUseId: 'cli-1', toolName: 'command_execution', input, result: output, error: 'STDERR: boom', isError: true });
  sink.release();
  await settle();

  expect(sink.events).toEqual([
    ['log', 'command_execution', input, { result: output, error: 'STDERR: boom' }],
    ['call', 'cli-1', 'command_execution', input],
    ['result', 'cli-1', false, 'STDERR: boom', output],
  ]);
});

// risk: lost evidence — a result with no observed start still gets its call row first, exactly once.
it('emits the call for a result whose start was never seen, and reports success', async() => {
  const sink = new RecordingSink();
  sink.release();
  const transcript = new ProviderToolTranscript(sink);

  transcript.finished({ toolUseId: 'cli-2', toolName: 'Read', input: { path: '/a' }, result: 'file body' });
  await settle();

  expect(sink.events.filter(event => event[0] !== 'log')).toEqual([
    ['call', 'cli-2', 'Read', { path: '/a' }],
    ['result', 'cli-2', true, undefined, 'file body'],
  ]);
});
