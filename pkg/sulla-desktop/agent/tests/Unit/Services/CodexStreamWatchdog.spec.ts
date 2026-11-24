// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexService } from '../../../languagemodels/CodexService';
import { getProviderExecutionTransport } from '../../../languagemodels/ProviderExecutionTransport';
import { providerBridgeActivity } from '../../../../vault-broker/ProviderBridgeActivity';
import { LONG_TOOL_CEILING_MS } from '../../../services/RunLivenessClock';

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
  const liveness = vi.fn();
  const finished = service.runCodex([
    { role: 'system', content: 'A synthetic watchdog test.' }, { role: 'user', content: 'Test only.' },
  ], { onActivity: (message: string, reportingActivity?: string) => activities.push({ message, reportingActivity }), onLiveness: liveness }, { conversationId: 'watchdog-test' })
    .then((value: unknown) => { outcome = value }, (error: Error) => { outcome = error });
  await vi.advanceTimersByTimeAsync(0);
  proc.emit('spawn');
  return { proc, finished, outcome: () => outcome, activities, liveness };
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
      expect(run.outcome()).toMatchObject({ kind: 'stall', message: 'Codex stalled: no output for 3 minutes (rate-limited by OpenAI: request rate limit exceeded)' });
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
    expect(run.outcome()).toMatchObject({ kind: 'stall', message: 'Codex stalled: no output for 3 minutes' });
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
    expect(run.outcome()).toMatchObject({ kind: 'stall', message: 'Codex stalled: no output for 3 minutes' });
  });

  // Jonathon (2026-11-24): an agent is stalled only when its WHOLE loop is idle.
  const emit = (run: Awaited<ReturnType<typeof launch>>, event: unknown) => run.proc.stdout.write(JSON.stringify(event) + '\n');

  it('does not kill a run that is silent in chat but keeps making tool calls', async() => {
    // risk: a working agent is killed as "stalled" because it sent no chat message
    const run = await launch();
    for (let call = 0; call < 6; call++) {
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 30_000);
      emit(run, { type: 'item.started', item: { id: `cmd-${ call }`, type: 'command_execution', command: 'npm test' } });
      await vi.advanceTimersByTimeAsync(20_000);
      emit(run, { type: 'item.completed', item: { id: `cmd-${ call }`, type: 'command_execution', command: 'npm test', exit_code: 0 } });
    }
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    expect(run.liveness).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
  });

  it('does not kill a run blocked on a long-running tool, then reports it as a hung tool past the ceiling', async() => {
    // risk: a 40-minute build or test run is killed as a dead agent while it is still working
    const run = await launch();
    emit(run, { type: 'item.started', item: { id: 'build-1', type: 'command_execution', command: 'yarn build' } });
    await vi.advanceTimersByTimeAsync(LONG_TOOL_CEILING_MS - 60_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
    expect(run.outcome()).toMatchObject({ kind: 'stall' });
    expect(run.outcome().message).toContain('tool still running for 120m: command_execution');
    expect(run.outcome().message).not.toContain('no output for 3 minutes');
  });

  it('counts model output relayed by the provider bridge (reasoning) as activity', async() => {
    // risk: a long reasoning turn with no JSONL lines yet is killed mid-thought
    const run = await launch();
    const pod = 'codex-watchdog-test-pod';
    for (let minute = 0; minute < 8; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      providerBridgeActivity.markModelOutput(pod);
    }
    expect(run.proc.kill).not.toHaveBeenCalled();
    expect(run.liveness).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 30_000);
    expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
    expect(run.outcome()).toMatchObject({ kind: 'stall', message: 'Codex stalled: no output for 3 minutes' });
  });
});
