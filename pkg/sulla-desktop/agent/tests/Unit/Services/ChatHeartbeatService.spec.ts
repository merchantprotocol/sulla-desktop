// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ChatHeartbeatService.ts is the real module under test here, so every one of
// its Electron/DOM/Postgres-touching transitive imports is mocked out —
// GraphRegistry alone drags in the full tool manifest registry (Electron),
// matching the convention SetChatHeartbeatWorker.spec.ts documents for the
// same reason. Only the actual branching logic (isGraphBusy, deliver) is real.
const { wakeParkedAgent, graphRegistryGet, hasLiveWaiter, wsSend, findTaskByThread, policyDefinitions } = vi.hoisted(() => ({
  wakeParkedAgent:   vi.fn(),
  graphRegistryGet:  vi.fn(),
  hasLiveWaiter:     vi.fn(),
  wsSend:            vi.fn(),
  findTaskByThread:  vi.fn(),
  policyDefinitions: { findBySlug: vi.fn(), get: vi.fn() },
}));

vi.mock('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry: { get: graphRegistryGet } }));
vi.mock('@pkg/agent/services/AgentJobLifecycleService', () => ({ agentJobLifecycle: { hasLiveWaiter } }));
vi.mock('@pkg/agent/services/BackendGraphWebSocketService', () => ({ getBackendGraphWebSocketService: () => ({ wakeParkedAgent }) }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: wsSend }) }));
vi.mock('@pkg/agent/services/AgentDefinitionService', () => ({ agentDefinitionService: policyDefinitions }));
vi.mock('@pkg/agent/tools/agents/jobRegistry', () => ({ findTaskByThread }));
vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('@pkg/agent/utils/agentLogger', () => ({ frontendGraphLogger: { warn: vi.fn(), log: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const allowedConfig = { heartbeat: { allowed: true, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 10 } };
const hiddenJobOwner = (threadId: string) => ({
  job:       { jobId: 'job-1', status: 'parked' as const, tasks: [{ agentId: 'lead', status: 'parked' as const, threadId, visibility: 'hidden' as const }] },
  taskIndex: 0,
});

async function freshScheduler() {
  vi.resetModules();
  const { getChatHeartbeatService } = await import('../../../services/ChatHeartbeatService');
  return getChatHeartbeatService();
}

describe('ChatHeartbeatService wiring — routes a beat to the right delivery path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wakeParkedAgent.mockReset();
    graphRegistryGet.mockReset();
    hasLiveWaiter.mockReset().mockReturnValue(false);
    wsSend.mockReset().mockResolvedValue(true);
    findTaskByThread.mockReset().mockResolvedValue(undefined);
    policyDefinitions.findBySlug.mockReset().mockResolvedValue({ id: 'lead-id', slug: 'lead', config: allowedConfig });
    policyDefinitions.get.mockReset().mockResolvedValue(null);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('delivers a hidden job thread through wakeParkedAgent, not the WebSocket send — acceptance 1', async() => {
    // risk: the root-cause bug (hardcoded triggerType) reappears and a hidden manager's beat silently resolves the default persona instead of itself
    findTaskByThread.mockResolvedValue(hiddenJobOwner('hidden-thread'));
    wakeParkedAgent.mockResolvedValue(true);
    const scheduler = await freshScheduler();

    scheduler.register({ threadId: 'hidden-thread', channel: 'sulla-desktop', config: { intervalMinutes: 1, message: 'beat' }, busy: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'hidden-thread', 'beat', 'lead', { intervalMinutes: 1 });
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('a plain thread with no job task falls back to the WebSocket send — regression: unchanged for a normal chat', async() => {
    // risk: every ordinary top-level chat heartbeat breaks because the new lookup assumes a job exists
    findTaskByThread.mockResolvedValue(undefined);
    const scheduler = await freshScheduler();

    scheduler.register({ threadId: 'plain-thread', channel: 'sulla-desktop', config: { intervalMinutes: 1, message: 'beat' }, busy: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wsSend).toHaveBeenCalled();
    expect(wakeParkedAgent).not.toHaveBeenCalled();
  });

  it('a job explicitly opened as a visible tab falls back to the WebSocket send — regression: unchanged tab behavior', async() => {
    // risk: a visible-tab job's heartbeat starts routing through the hidden-job wake path and breaks
    findTaskByThread.mockResolvedValue({ job: { jobId: 'job-2', status: 'running', tasks: [{ agentId: 'lead', status: 'running', threadId: 'tab-thread', visibility: 'tab' }] }, taskIndex: 0 });
    const scheduler = await freshScheduler();

    scheduler.register({ threadId: 'tab-thread', channel: 'sulla-desktop', config: { intervalMinutes: 1, message: 'beat' }, busy: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wsSend).toHaveBeenCalled();
    expect(wakeParkedAgent).not.toHaveBeenCalled();
  });

  it('a manager parked mid in-process wait is not blocked forever by the cycleComplete busy check', async() => {
    // risk: isGraphBusy's cycleComplete flag stays false for the whole outer turn a wait is blocked inside, pausing the heartbeat indefinitely
    hasLiveWaiter.mockReturnValue(true);
    graphRegistryGet.mockReturnValue({ state: { metadata: { cycleComplete: false } } });
    findTaskByThread.mockResolvedValue(hiddenJobOwner('hidden-thread'));
    wakeParkedAgent.mockResolvedValue(true);
    const scheduler = await freshScheduler();

    scheduler.register({ threadId: 'hidden-thread', channel: 'sulla-desktop', config: { intervalMinutes: 1, message: 'beat' }, busy: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wakeParkedAgent).toHaveBeenCalled();
  });

  it('a regular tab mid-cycle (cycleComplete false, no live waiter) still pauses instead of delivering — regression', async() => {
    // risk: the hasLiveWaiter short-circuit widens beyond parked job threads and heartbeats interrupt a running chat
    hasLiveWaiter.mockReturnValue(false);
    graphRegistryGet.mockReturnValue({ state: { metadata: { cycleComplete: false } } });
    findTaskByThread.mockResolvedValue(undefined);
    const scheduler = await freshScheduler();

    scheduler.register({ threadId: 'tab-thread', channel: 'sulla-desktop', config: { intervalMinutes: 1, message: 'beat' }, busy: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wsSend).not.toHaveBeenCalled();
    expect(scheduler.status('tab-thread')).toMatchObject({ paused: true });
  });
});
