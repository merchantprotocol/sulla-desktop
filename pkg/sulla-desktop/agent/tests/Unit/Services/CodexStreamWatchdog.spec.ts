// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexService } from '../../../languagemodels/CodexService';
import { getProviderExecutionTransport } from '../../../languagemodels/ProviderExecutionTransport';
import { providerBridgeActivity } from '../../../vault-broker/ProviderBridgeActivity';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../languagemodels/ProviderExecutionTransport', () => ({
  getProviderExecutionTransport: vi.fn(), requireBrokeredContainerAuth: () => ({}), requireContainerToolConfig: () => ({}),
}));
vi.mock('../../../services/AgentContainerRuntimeRegistry', () => ({
  currentAgentContainerRuntime: () => ({
    podId: 'codex-watchdog-test-pod', subject: 'test', jobId: 'test', deviceId: 'test', workspacePath: '/tmp',
  }),
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
  const activities: Array<{ message: string; reportingActivity?: string }> = [];
  const finished = service.runCodex([
    { role: 'system', content: 'A synthetic watchdog test.' }, { role: 'user', content: 'Test only.' },
  ], { onActivity: (message: string, reportingActivity?: string) => activities.push({ message, reportingActivity }) }, { conversationId: 'watchdog-test' })
    .then((value: unknown) => { outcome = value }, (error: Error) => { outcome = error });
  await vi.advanceTimersByTimeAsync(0);
  proc.emit('spawn');
  return { proc, finished, outcome: () => outcome, activities };
}

describe('Codex quiet stream watchdog', () => {
  it('shows retry state but still stalls at three minutes with the last rate-limit reason', async() => {
    // risk: stalled Codex run hangs indefinitely while unrelated bridge activity masks silence
    const run = await launch();
    const bridgePodId = 'codex-watchdog-test-pod';
    providerBridgeActivity.mark(bridgePodId);
    const bridgeHeartbeat = setInterval(() => providerBridgeActivity.mark(bridgePodId), 30_000);
    try {
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 30_000);
      providerBridgeActivity.publishRetryStatus(bridgePodId, { status: 429, retryAfterSeconds: 9 });
      providerBridgeActivity.publishRetryStatus(bridgePodId, { status: 429, reason: 'request rate limit exceeded', retryAfterSeconds: 9 });
      providerBridgeActivity.publishRetryStatus(bridgePodId, { status: 503 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(providerBridgeActivity.lastActivityAt(bridgePodId)).toBe(Date.now());
      expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(5_000);
      await run.finished;
      expect(run.activities).toContainEqual({ message: 'Codex is rate-limited, retrying', reportingActivity: 'status' });
      expect(run.activities).toContainEqual({ message: 'Codex is busy, retrying', reportingActivity: 'status' });
      expect(run.outcome()).toMatchObject({ faultKind: 'stall', message: 'Codex stalled: no output for 3 minutes (rate-limited by OpenAI: request rate limit exceeded)' });
    } finally {
      clearInterval(bridgeHeartbeat);
    }
  });

  it('terminates a silent process at three minutes and settles after teardown', async() => {
    // risk: Codex remains stuck beyond Jonathon's three-minute silence limit
    const run = await launch();
    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
    expect(run.proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
    expect(run.outcome()).toMatchObject({ faultKind: 'stall', message: 'Codex stalled: no output for 3 minutes' });
  });

  it('resets the silence clock when stdout arrives at 2:59', async() => {
    // risk: real Codex output is ignored and an active model turn is killed
    const run = await launch();
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 59_000);
    run.proc.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning' } }) + '\n');
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 59_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
    expect(run.outcome()).toMatchObject({ faultKind: 'stall', message: 'Codex stalled: no output for 3 minutes' });
  });
});
