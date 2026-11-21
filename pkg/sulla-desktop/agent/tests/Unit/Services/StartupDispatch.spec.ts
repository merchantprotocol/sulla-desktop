// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ ready: false }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false } }));
vi.mock('../../../services/AgentExecutionReadiness', async importActual => {
  const actual = await importActual<typeof import('../../../services/AgentExecutionReadiness')>();
  const gate = new actual.AgentExecutionReadiness(() => Promise.resolve(runtime.ready ? undefined : 'Password Vault'), 10);
  return { ...actual, agentExecutionReadiness: gate, waitForAutomaticAgentExecution: gate.wait.bind(gate) };
});
async function fixture() {
  const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
  const service = Object.create(BackendGraphWebSocketService.prototype);
  service.readinessWaits = new Map();
  service.dispatchedRuns = new Set();
  service.activeAborts = new Map();
  service.restartResumeCheckin = vi.fn(() => Promise.resolve(null));
  service.emitMessage = vi.fn();
  service.executeReadyTurn = vi.fn(() => Promise.resolve('accepted'));
  return service;
}
afterEach(() => { runtime.ready = false; vi.useRealTimers(); vi.restoreAllMocks() });
describe('startup-only dispatch guard', () => {
  it('waits beyond one minute without failure and retains attachments and routing', async() => {
    vi.useFakeTimers();
    const service = await fixture();
    const metadata = { attachments: [{ type: 'image', data: 'fixture' }], modelSelection: { model: 'sol' } };
    const request = service.dispatchToAgent('desktop', 'sulla-desktop', 'work', 'thread', undefined, 'chosen-agent', 'keyboard', metadata);
    await vi.advanceTimersByTimeAsync(65000);
    expect(service.executeReadyTurn).not.toHaveBeenCalled();
    expect(service.emitMessage).toHaveBeenCalledTimes(1);
    runtime.ready = true;
    await vi.advanceTimersByTimeAsync(10);
    await expect(request).resolves.toBe('accepted');
    expect(service.executeReadyTurn.mock.calls[0]).toEqual(['desktop', 'sulla-desktop', 'work', 'thread', undefined, 'chosen-agent', 'keyboard', metadata, undefined]);
  });
  it('does not serialize running chat turns after readiness', async() => {
    const service = await fixture(); runtime.ready = true;
    let finish!: () => void;
    service.executeReadyTurn.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve('accepted') }));
    const first = service.dispatchToAgent('desktop', 'sulla-desktop', 'first', 'thread');
    await vi.waitFor(() => expect(service.executeReadyTurn).toHaveBeenCalledTimes(1));
    const second = service.dispatchToAgent('desktop', 'sulla-desktop', 'replace first', 'thread');
    await expect(second).resolves.toBe('accepted');
    expect(service.executeReadyTurn).toHaveBeenCalledTimes(2);
    finish(); await first;
  });
  it('does not scan or claim interrupted jobs before dependencies become ready', async() => {
    vi.useFakeTimers(); const service = await fixture();
    service.recoveryAbort = new AbortController();
    service.recoverRuntimeWork = vi.fn(() => Promise.resolve());
    const recovery = service.recoverWhenReady();
    await vi.advanceTimersByTimeAsync(65000);
    expect(service.recoverRuntimeWork).not.toHaveBeenCalled();
    runtime.ready = true; await vi.advanceTimersByTimeAsync(10); await recovery;
    expect(service.recoverRuntimeWork).toHaveBeenCalledTimes(1);
  });
  it('shutdown cancels waiting input and waits for tracked cleanup', async() => {
    vi.useFakeTimers(); const service = await fixture();
    service.recoveryAbort = new AbortController(); service.unsubscribes = []; service.dispose = vi.fn();
    const { GraphRegistry } = await import('../../../services/GraphRegistry');
    const { agentWaitProvider } = await import('../../../services/AgentWaitServices');
    const abortGraphs = vi.spyOn(GraphRegistry, 'abortRuntimeRuns').mockImplementation(() => {});
    const stopScheduler = vi.spyOn(agentWaitProvider.scheduler, 'stop').mockImplementation(() => {});
    const request = service.dispatchToAgent('desktop', 'sulla-desktop', 'waiting', 'thread');
    await vi.advanceTimersByTimeAsync(0); await service.drain();
    await expect(request).resolves.toBe('deferred');
    expect(service.executeReadyTurn).not.toHaveBeenCalled(); expect(stopScheduler).toHaveBeenCalledOnce();
    expect(abortGraphs).toHaveBeenCalledOnce(); expect(service.dispose).toHaveBeenCalledOnce();
    abortGraphs.mockRestore(); stopScheduler.mockRestore();
  });
  it('Stop cancels only the waiting thread and never starts it after services recover', async() => {
    vi.useFakeTimers();
    const service = await fixture();
    const first = service.dispatchToAgent('desktop', 'sulla-desktop', 'stop me', 'one');
    const second = service.dispatchToAgent('desktop', 'sulla-desktop', 'keep me', 'two');
    await vi.advanceTimersByTimeAsync(0);
    await service.handleChannelMessage('desktop', 'sulla-desktop', { type: 'stop_run', data: { threadId: 'one' } });
    await expect(first).resolves.toBe('deferred');
    runtime.ready = true; await vi.advanceTimersByTimeAsync(10);
    await expect(second).resolves.toBe('accepted');
    expect(service.executeReadyTurn.mock.calls.map((args: any[]) => args[2])).toEqual(['keep me']);
  });
  it('starts another recovered worker without waiting for the first to finish', async() => {
    runtime.ready = true;
    const service = await fixture(); service.recoveryAbort = new AbortController();
    service.hasActiveRun = vi.fn((_channel: string, threadId: string) =>
      service.executeReadyTurn.mock.calls.some((args: any[]) => args[3] === threadId));
    let finish!: () => void;
    service.executeReadyTurn.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve('accepted') }));
    const job = { jobId: 'old', parentChannel: 'desktop', tasks: [{ threadId: 'one', agentId: 'luna' }, { threadId: 'two', agentId: 'luna' }] };
    const firstLaunch = service.resumeInterruptedTask(job, 0); const secondLaunch = service.resumeInterruptedTask(job, 1);
    await vi.waitFor(() => expect(service.executeReadyTurn).toHaveBeenCalledTimes(2));
    await Promise.all([firstLaunch, secondLaunch]);
    expect(service.executeReadyTurn.mock.calls.map((args: any[]) => args[3])).toEqual(['one', 'two']);
    finish(); await Promise.all([...service.dispatchedRuns]);
  });

  it('reports an early recovered-worker dispatch failure to the startup retry loop', async() => {
    vi.useFakeTimers(); runtime.ready = true;
    const service = await fixture(); service.recoveryAbort = new AbortController();
    service.dispatchToAgent = vi.fn(() => Promise.reject(new Error('temporary dispatch failure')));
    const job = { jobId: 'old', parentChannel: 'desktop', tasks: [{ threadId: 'one', agentId: 'quick-fixer' }] };

    const launch = service.resumeInterruptedTask(job, 0);
    const rejected = expect(launch).rejects.toThrow('temporary dispatch failure');
    await vi.runAllTimersAsync();

    await rejected;
  });

  it('rechecks skipped startup jobs, excludes new work and never reclaims an already resumed job', async() => {
    vi.useFakeTimers(); runtime.ready = true;
    const service = await fixture(); service.recoveryAbort = new AbortController();
    service.recoveryCutoff = Date.now(); service.agentInbox = { replayPending: vi.fn() };
    service.subscribeToAgentChannels = vi.fn(); service.hasPendingDecision = vi.fn().mockResolvedValue(true);
    service.hasActiveRun = vi.fn((_channel: string, threadId: string) => threadId === 'busy-sibling');
    const { agentJobProvider } = await import('../../../app/Providers/AgentJobServiceProvider');
    const { agentWaitProvider } = await import('../../../services/AgentWaitServices');
    const completion = await import('../../../services/AgentCompletionRecoveryService');
    const lifecycle = await import('../../../services/AgentJobLifecycleService');
    const registry = await import('../../../services/AgentContainerRuntimeRegistry');
    const pause = await import('../../../services/AgentLaunchPauseService');
    vi.spyOn(pause.agentLaunchPauseService, 'isPaused').mockResolvedValue(false);
    vi.spyOn(registry, 'probeAgentContainerRuntime').mockReturnValue(false);
    vi.spyOn(agentWaitProvider.scheduler, 'start').mockResolvedValue(undefined);
    vi.spyOn(completion, 'recoverPendingAgentCompletions').mockResolvedValue(undefined);
    vi.spyOn(lifecycle.returnedTaskSettlement, 'settleStranded').mockResolvedValue(0);
    const old = { jobId: 'old', createdAt: service.recoveryCutoff - 1000, status: 'running', visibility: 'hidden', parentChannel: 'desktop', tasks: [
      { status: 'running', threadId: 'busy-sibling', agentId: 'luna' },
      { status: 'running', threadId: 'old-thread', agentId: 'luna' },
    ] } as any;
    const newer = { ...old, jobId: 'new', createdAt: service.recoveryCutoff + 1000 };
    vi.spyOn(agentJobProvider.jobs, 'jobsForList').mockResolvedValue([old, newer]);
    const claim = vi.spyOn(agentJobProvider.states, 'claimInterruptedJob').mockImplementation(async(_id, _max, eligible) =>
      await eligible!(old) ? { resumable: [old], exhausted: [] } : { resumable: [], exhausted: [] });
    const run = service.recoverRuntimeWork();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.executeReadyTurn).not.toHaveBeenCalled();
    service.hasPendingDecision.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(30000); await run;
    await vi.advanceTimersByTimeAsync(0);
    expect(claim.mock.calls.map(call => call[0])).toEqual(['old', 'old']);
    expect(service.executeReadyTurn).toHaveBeenCalledTimes(1);
    expect(service.executeReadyTurn.mock.calls[0][3]).toBe('old-thread');
  });
});
