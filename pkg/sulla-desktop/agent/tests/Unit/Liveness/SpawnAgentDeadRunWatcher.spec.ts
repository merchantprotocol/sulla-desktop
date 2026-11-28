// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: async() => true }) }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: vi.fn(async() => 1) },
}));

import { RunActivity, watchForDeadRun } from '../../../services/RunActivity';
import { runTools } from '../../../services/RunToolTracker';
import { BaseNode } from '../../../nodes/BaseNode';
import { ToolExecutor } from '../../../controllers/ToolExecutor';
import { toolRegistry } from '../../../tools/registry';
import { LONG_TOOL_CEILING_MS } from '../../../services/RunLivenessClock';
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';

describe('SpawnAgentDeadRunWatcher liveness floor', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() });

  it('does not stop a no-check-in spawn at the configured one-minute threshold', async() => {
    // risk: orchestration liveness — a fresh worker can be killed before its first progress report.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('fresh-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => false });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(onDead).toHaveBeenCalledOnce();
    stop();
  });

  it('keeps a streaming worker with no check-in alive past ten minutes and kills it only after the real threshold', async() => {
    // risk: orchestration liveness — live Opus workers were stopped at ~600 s with "no activity for 30 minutes".
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('streaming-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => false });
    const metadata = { activityKeys: ['streaming-spawn'] };
    for (let minute = 1; minute <= 12; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      RunActivity.touch(metadata); // model tokens / tool calls
    }
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onDead).toHaveBeenCalledOnce();
    expect(onDead.mock.calls[0][0]).toBe('no agent activity for 30 minute(s) (limit 30)');
    stop();
  });

  it('treats a long-running tool call as activity', async() => {
    // risk: orchestration liveness — a worker running a long shell command emits nothing until it ends.
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('tool-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => true });
    const metadata = { activityKeys: ['tool-spawn'] };
    runTools.started(metadata, 'call-1', 'a command');
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    runTools.finished(metadata, 'call-1');
    stop();
  });

  // Jonathon (2026-11-24): judge liveness by the whole agent loop, not chat
  // messages. These drive the real BaseNode provider callbacks and the real
  // ToolExecutor, the two places a turn's tool calls reach the job clock.
  it('keeps a job alive that sends no chat or check-in but keeps making provider tool calls', async() => {
    // risk: orchestration liveness — busy workers were reaped because tool calls never touched the job clock
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('tools-only-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => false });
    const turn = providerTurn(['tools-only-spawn'], async(callbacks) => {
      for (let call = 0; call < 4; call++) {
        await sleep(5 * 60_000);
        callbacks.onToolStarted({ toolUseId: `item_${ call }`, toolName: 'command_execution' });
        // A 25-minute build prints nothing; the run has no other activity meanwhile.
        await sleep(25 * 60_000);
        callbacks.onToolEvent({ toolUseId: `item_${ call }`, toolName: 'command_execution', resultChars: 10 });
      }
    });
    await vi.advanceTimersByTimeAsync(4 * 30 * 60_000);
    await turn;
    expect(onDead).not.toHaveBeenCalled();
    stop();
  });

  it('keeps a job alive while one parallel task runs item_3 after another task finished its own item_3', async() => {
    // risk: orchestration liveness — Codex item ids repeat per process, so task A finishing item_3 freed task B's 90-minute build and the job was reaped
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('parallel-job', onDead, async() => false, { createdAt: 0, hasCheckin: async() => true });
    const taskB = providerTurn(['parallel-job', 'parallel-job#1'], async(callbacks) => {
      callbacks.onToolStarted({ toolUseId: 'item_3', toolName: 'yarn build' });
      await sleep(90 * 60_000);
      callbacks.onToolEvent({ toolUseId: 'item_3', toolName: 'yarn build', resultChars: 10 });
    });
    const taskA = providerTurn(['parallel-job', 'parallel-job#0'], async(callbacks) => {
      callbacks.onToolStarted({ toolUseId: 'item_3', toolName: 'command_execution' });
      await sleep(60_000);
      callbacks.onToolEvent({ toolUseId: 'item_3', toolName: 'command_execution', resultChars: 10 });
    });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await taskA;
    expect(RunActivity.toolInFlight('parallel-job')).toMatchObject({ name: 'yarn build' });
    await vi.advanceTimersByTimeAsync(80 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await taskB;
    stop();
  });

  it('keeps a job alive while a provider tool runs for 90 minutes, then reports a hung tool past the ceiling', async() => {
    // risk: orchestration liveness — a long build is reaped as a dead agent instead of a running tool
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('long-tool-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => true });
    const turn = providerTurn(['long-tool-spawn'], async(callbacks) => {
      callbacks.onToolStarted({ toolUseId: 'build-1', toolName: 'yarn build' });
      await sleep(LONG_TOOL_CEILING_MS + 10 * 60_000);
    });
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LONG_TOOL_CEILING_MS - 90 * 60_000 + 60_000);
    expect(onDead).toHaveBeenCalledOnce();
    expect(onDead.mock.calls[0][1]).toBe('tool_hung');
    expect(onDead.mock.calls[0][0]).toMatch(/^tool still running for 120m: yarn build/);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await turn;
    stop();
  });

  it('keeps a job alive while an in-process approval waits on the human past the tool ceiling', async() => {
    // risk: orchestration liveness — an agent waiting on Jonathon's approval is reaped as a hung tool or dead agent
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('approval-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => true });
    const waits = LONG_TOOL_CEILING_MS + 60 * 60_000;
    const call = executeTool(['approval-spawn'], 'ask_user_question', waits);
    await vi.advanceTimersByTimeAsync(waits - 60_000);
    expect(onDead).not.toHaveBeenCalled();
    expect(RunActivity.toolInFlight('approval-spawn')).toMatchObject({ name: 'ask_user_question' });
    await vi.advanceTimersByTimeAsync(60_000);
    await call;
    expect(RunActivity.toolInFlight('approval-spawn')).toBeUndefined();
    stop();
  });

  it('stops a job with no events of any kind for the limit', async() => {
    // risk: orchestration liveness — a truly dead run must still be reaped
    vi.mocked(SullaSettingsModel.get).mockResolvedValue(30 as any);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDead = vi.fn();
    const stop = watchForDeadRun('dead-spawn', onDead, async() => false, { createdAt: 0, hasCheckin: async() => true });
    const call = executeTool(['dead-spawn'], 'exec', 0);
    await vi.advanceTimersByTimeAsync(0);
    await call;
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onDead).toHaveBeenCalledOnce();
    expect(onDead.mock.calls[0]).toEqual(['no agent activity for 30 minute(s) (limit 30)', 'idle']);
    stop();
  });

  it('forgets a run\'s open tool calls when the run ends', async() => {
    // risk: orchestration liveness — a stale entry from an ended run keeps its key "busy" forever
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stop = watchForDeadRun('ended-spawn', vi.fn(), async() => false, { createdAt: 0, hasCheckin: async() => true });
    runTools.started({ activityKeys: ['ended-spawn'] }, 'orphan', 'a command whose turn never closed');
    expect(RunActivity.toolInFlight('ended-spawn')).toBeDefined();
    stop();
    expect(RunActivity.toolInFlight('ended-spawn')).toBeUndefined();
  });
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

class LivenessProbeNode extends BaseNode {
  constructor() { super('liveness-probe', 'Liveness probe') }
  async execute(state: any): Promise<any> { return { state, decision: { type: 'end' } } }
}

type ProviderCallbacks = {
  onToolStarted: (event: { toolUseId: string; toolName: string }) => void;
  onToolEvent:   (event: { toolUseId: string; toolName: string; resultChars: number }) => void;
};

/** One real BaseNode turn whose provider runs `script` with the callbacks BaseNode hands it. */
function providerTurn(activityKeys: string[], script: (callbacks: ProviderCallbacks) => Promise<void>): Promise<unknown> {
  const node = new LivenessProbeNode();
  vi.spyOn(node as any, 'wsChatMessage').mockResolvedValue(undefined);
  const state = { metadata: { threadId: `t-${ activityKeys.at(-1) }`, agentId: 'probe', activityKeys, options: {} }, messages: [{ role: 'user', content: 'work' }] } as any;
  const provider = {
    getModel: () => 'test',
    getProviderName: () => 'liveness-probe',
    chatStream: async(_messages: unknown, callbacks: ProviderCallbacks) => {
      await script(callbacks);
      return { content: 'done', metadata: {} };
    },
  };
  return (node as any).callLLMStreaming(state, [...state.messages], {}, {}, provider);
}

/** One in-process tool call through the real ToolExecutor that takes `ms` to return. */
function executeTool(activityKeys: string[], name: string, ms: number): Promise<unknown> {
  vi.spyOn(toolRegistry, 'createTool').mockResolvedValue({ invoke: () => sleep(ms).then(() => ({ success: true, result: 'ok' })) } as any);
  const executor = new ToolExecutor({ nodeId: 'probe', nodeName: 'probe', currentNodeRunContext: null, wsChatMessage: async() => true, bumpStateVersion: () => {} });
  for (const method of ['getToolPolicyBlockReason', 'emitToolCallEvent', 'emitToolResultEvent', 'appendToolResultMessage']) {
    vi.spyOn(executor as any, method).mockResolvedValue(null);
  }
  vi.spyOn(executor as any, 'persistStructuredToolRunRecord').mockReturnValue(undefined);
  const state = { metadata: { threadId: 't', activityKeys }, messages: [] } as any;
  return executor.executeToolCalls(state, [{ name, id: `${ name }-1`, args: {} }]);
}
