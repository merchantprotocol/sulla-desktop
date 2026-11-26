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
// Container runs carry a runtime pod; VM runs have none and rely on the bridge lease's pod.
const runtimePod = vi.hoisted(() => ({ id: 'codex-watchdog-test-pod' as string | undefined }));
const VM_LEASE_POD = 'sulla-guest-codex-watchdog-lease';
vi.mock('../../../services/AgentContainerRuntimeRegistry', () => ({
  currentAgentContainerRuntime: () => runtimePod.id
    ? { podId: runtimePod.id, subject: 'test', jobId: 'test', deviceId: 'test', workspacePath: '/tmp' }
    : undefined,
}));
vi.mock('@pkg/backend/guestClis', () => ({ ensureGuestCli: vi.fn(async() => {}) }));
vi.mock('../../../languagemodels/codexExecutionAuth', () => ({
  resolveCodexExecutionAuth: vi.fn(async() => ({
    kind: 'container-broker-lease', environment: {}, codexConfigOverrides: [], podId: VM_LEASE_POD, dispose: () => {},
  })),
}));
vi.mock('../../../languagemodels/providerSessionStore', () => ({ providerSessionStore: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../../tools/agents/workerMessaging', () => ({ prepareWorkerTurnPrompt: (_state: unknown, prompt: string) => prompt }));
vi.mock('../../../utils/steerChannel', () => ({ onSteer: () => () => {}, markSteerPending: vi.fn() }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));

beforeEach(() => { runtimePod.id = 'codex-watchdog-test-pod'; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z')) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() });

async function launch(runtime: 'container' | 'guest' = 'container') {
  if (runtime === 'guest') runtimePod.id = undefined;
  const proc = Object.assign(new EventEmitter(), {
    stdin:    new PassThrough(),
    stdout:   new PassThrough(),
    stderr:   new PassThrough(),
    exitCode: null,
    kill:     vi.fn(() => true),
  });
  vi.mocked(getProviderExecutionTransport).mockReturnValue({
    runtime,
    context:   vi.fn(() => Promise.resolve({ runtime })),
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
  it('counts 429/503 provider retry states as activity, then stalls after retries go quiet', async() => {
    // risk: provider backoff is misclassified as silence and kills a healthy run mid-retry.
    const run = await launch();
    const bridgePodId = 'codex-watchdog-test-pod';
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 30_000);
    providerBridgeActivity.publishRetryStatus(bridgePodId, { status: 429, reason: 'request rate limit exceeded', retryAfterSeconds: 9 });
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 59_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    providerBridgeActivity.publishRetryStatus(bridgePodId, { status: 503 });
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 59_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
    expect(run.activities).toContainEqual({ message: 'Codex is rate-limited, retrying', reportingActivity: 'status' });
    expect(run.activities).toContainEqual({ message: 'Codex is busy, retrying', reportingActivity: 'status' });
    expect(run.outcome()).toMatchObject({ kind: 'stall', message: 'Codex stalled: no output for 3 minutes (rate-limited by OpenAI: request rate limit exceeded)', retrySafe: true, unsafeToFallback: false });
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
    expect(run.outcome()).toMatchObject({ kind: 'stall', message: 'Codex stalled: no output for 3 minutes', retrySafe: true, unsafeToFallback: false });
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

  it('does not kill a run that is silent in chat but keeps running long tool calls', async() => {
    // risk: a working agent is killed as "stalled" because it sent no chat message
    const run = await launch();
    for (let call = 0; call < 3; call++) {
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 30_000);
      emit(run, { type: 'item.started', item: { id: `cmd-${ call }`, type: 'command_execution', command: 'npm test' } });
      // A 10-minute command prints nothing until it ends: more than three times the silence limit.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(run.proc.kill).not.toHaveBeenCalled();
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
    expect(run.outcome()).toMatchObject({ retrySafe: false, unsafeToFallback: true });
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

  it('keeps a run waiting on the human alive past the tool ceiling', async() => {
    // risk: an agent waiting on an approval or question is killed as hung while the human decides
    const run = await launch();
    emit(run, { type: 'item.started', item: { id: 'ask-1', type: 'mcp_tool_call', tool: 'ask_user_question' } });
    await vi.advanceTimersByTimeAsync(LONG_TOOL_CEILING_MS + 60 * 60_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    emit(run, { type: 'item.completed', item: { id: 'ask-1', type: 'mcp_tool_call', tool: 'ask_user_question' } });
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 30_000);
    expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
  });

  it('counts relayed model output for a VM run on a bridge lease, and shows its retry state', async() => {
    // risk: a VM Codex run reasoning past three minutes is killed because the stall clock reads no pod
    const run = await launch('guest');
    for (let minute = 0; minute < 8; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      providerBridgeActivity.markModelOutput(VM_LEASE_POD);
    }
    expect(run.proc.kill).not.toHaveBeenCalled();
    expect(run.liveness).toHaveBeenCalled();
    providerBridgeActivity.publishRetryStatus(VM_LEASE_POD, { status: 429, reason: 'request rate limit exceeded', retryAfterSeconds: 9 });
    expect(run.activities).toContainEqual({ message: 'Codex is rate-limited, retrying', reportingActivity: 'status' });
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 30_000);
    expect(run.proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    await run.finished;
    expect(run.outcome()).toMatchObject({ kind: 'stall', message: 'Codex stalled: no output for 3 minutes (rate-limited by OpenAI: request rate limit exceeded)' });
  });
});
