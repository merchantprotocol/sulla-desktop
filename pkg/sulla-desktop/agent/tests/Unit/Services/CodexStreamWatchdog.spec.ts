// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexService } from '../../../languagemodels/CodexService';
import { getProviderExecutionTransport } from '../../../languagemodels/ProviderExecutionTransport';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../languagemodels/ProviderExecutionTransport', () => ({
  getProviderExecutionTransport: vi.fn(), requireBrokeredContainerAuth: () => ({}), requireContainerToolConfig: () => ({}),
}));
vi.mock('../../../languagemodels/providerSessionStore', () => ({ providerSessionStore: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../../tools/agents/workerMessaging', () => ({ prepareWorkerTurnPrompt: (_state: unknown, prompt: string) => prompt }));
vi.mock('../../../utils/steerChannel', () => ({ onSteer: () => () => {}, markSteerPending: vi.fn() }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z')) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() });

async function launch() {
  const proc = Object.assign(new EventEmitter(), {
    stdin:    new PassThrough(),
    stdout:   new PassThrough(),
    stderr:   new PassThrough(),
    exitCode: null,
    kill:     vi.fn(() => true),
  });
  vi.mocked(getProviderExecutionTransport).mockReturnValue({
    runtime:   'container',
    context:   vi.fn(() => Promise.resolve({ runtime: 'container' })),
    files:     { write: vi.fn(() => Promise.resolve({ path: '/tmp/test-instructions.md', dispose: vi.fn() })) },
    spawn:     vi.fn(() => proc),
    terminate: vi.fn(async() => {}),
  } as any);
  const service = createCodexService('gpt-6-luna', 'max') as any;
  vi.spyOn(service, 'buildUserMessageContextPrefix').mockResolvedValue({ prefix: '', stableHash: '' });
  let outcome: any;
  const finished = service.runCodex([
    { role: 'system', content: 'A synthetic watchdog test.' }, { role: 'user', content: 'Test only.' },
  ], {}, { conversationId: 'watchdog-test' }).then((value: unknown) => { outcome = value }, (error: Error) => { outcome = error });
  await vi.advanceTimersByTimeAsync(0);
  proc.emit('spawn');
  return { proc, finished, outcome: () => outcome };
}

describe('Codex quiet stream watchdog', () => {
  it('allows a quiet reasoning interval beyond three minutes, then accepts the result', async() => {
    const run = await launch();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    run.proc.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Completed after quiet reasoning.' } }) + '\n');
    run.proc.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n');
    run.proc.emit('close', 0);
    await run.finished;
    expect(run.outcome().text).toBe('Completed after quiet reasoning.');
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
  });

  it('still terminates a silent process at ten minutes and settles after teardown', async() => {
    const run = await launch();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(run.proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
    expect(run.outcome()).toMatchObject({ kind: 'stall' });
    expect(run.outcome().message).toContain('10 minutes');
  });

  it('resets the silence clock on actual stream bytes', async() => {
    const run = await launch();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    run.proc.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning' } }) + '\n');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(65_000);
    await run.finished;
    expect(run.outcome()).toMatchObject({ kind: 'stall' });
  });
});
