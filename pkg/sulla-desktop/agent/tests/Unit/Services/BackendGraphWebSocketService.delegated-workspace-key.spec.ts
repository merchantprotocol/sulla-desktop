// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAgentContainerLifecycle } = vi.hoisted(() => ({
  createAgentContainerLifecycle: vi.fn((_run: any) => Promise.resolve({ closed: false, close: vi.fn(() => Promise.resolve()) })),
}));
const { getJob, SAVED_CLI } = vi.hoisted(() => {
  const saved = { 'claude-code': { mode: 'versioned', version: '2.1.0' }, codex: { mode: 'image-default' }, opencode: { mode: 'image-default' }, cursor: { mode: 'image-default' } };
  // The durable job row is the only source of a delegated task's creation-time CLI selection.
  return { SAVED_CLI: saved, getJob: vi.fn((jobId: string) => Promise.resolve(jobId === 'job-1' ? { jobId, tasks: [{ providerCliSnapshot: saved }] } : null)) };
});
const { captureProviderCliSnapshot, CURRENT_CLI } = vi.hoisted(() => ({
  CURRENT_CLI: { 'claude-code': { mode: 'versioned', version: '2.2.0' }, codex: { mode: 'versioned', version: '0.170.0' }, opencode: { mode: 'image-default' }, cursor: { mode: 'image-default' } },
  captureProviderCliSnapshot: vi.fn(() => Promise.resolve({
    'claude-code': { mode: 'versioned', version: '2.2.0' }, codex: { mode: 'versioned', version: '0.170.0' }, opencode: { mode: 'image-default' }, cursor: { mode: 'image-default' },
  })),
}));
vi.mock('../../../services/AgentContainerLauncher', () => ({ createAgentContainerLifecycle }));
vi.mock('../../../tools/agents/jobRegistry', async() => ({ ...await vi.importActual<object>('../../../tools/agents/jobRegistry'), getJob }));
vi.mock('@pkg/backend/providerCliUpdates', () => ({ captureProviderCliSnapshot }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

// Thread from the 2026-11-14 incident: before the restart its spawn_agent run
// used folder 3f18ac0d…, after the wake it landed in an empty 9cdf656c….
const THREAD_ID = 'spawn-agent-merge-train-11-perf-audit-prs-staging-1794711421361-0';
const ORIGINAL_FOLDER = '3f18ac0d000fd6df9f3f27daf8dfb18d';
const folderOf = (key: string) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);

const parkedIdentity = (visibility: 'hidden' | 'tab' | undefined, threadId = THREAD_ID) => ({
  job:       { jobId: 'job-1', status: 'running', parentChannel: 'sulla-desktop', visibility, tasks: [] },
  task:      { agentId: 'codex-sol-worker', threadId, status: 'parked', depth: 1, visibility },
  taskIndex: 0,
  agentId:   'codex-sol-worker',
}) as any;

const chatState = (threadId: string) => ({ metadata: { threadId, agentId: 'codex-sol-worker', agent: {} }, messages: [] }) as any;

async function containerKeyFor(channelId: string, threadId: string, state: any): Promise<string> {
  const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
  const service = Object.create(BackendGraphWebSocketService.prototype);
  service.conversationContainers = new Map();
  service.activeAborts = new Map();
  service.conversationContainerStarts = new Map();
  await service.conversationContainer(channelId, threadId, 'codex', state);
  for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  return createAgentContainerLifecycle.mock.calls.at(-1)![0].persistenceKey;
}

describe('conversation container persistence key after a parked delegated wake', () => {
  beforeEach(() => {
    createAgentContainerLifecycle.mockClear();
    getJob.mockClear();
    captureProviderCliSnapshot.mockReset().mockImplementation(() => Promise.resolve(CURRENT_CLI));
  });

  it('reuses the spawn_agent workspace folder when a hidden delegated thread is woken after a restart', async() => {
    // risk: a woken worker gets a brand-new empty workspace and loses its clone and CLI session state
    const { parkedAgentRehydrator } = await import('../../../services/ParkedAgentRehydrator');
    const { delegatedThreadPersistenceKey } = await import('../../../services/DelegatedContainerKey');
    const state = chatState(THREAD_ID);
    parkedAgentRehydrator.apply(state, parkedIdentity('hidden'));

    const key = await containerKeyFor('sulla-desktop', THREAD_ID, state);

    expect(key).toBe(delegatedThreadPersistenceKey(THREAD_ID));
    expect(folderOf(key)).toBe(ORIGINAL_FOLDER);
    // A woken worker keeps the CLI versions saved when its job was created.
    expect(getJob).toHaveBeenCalledWith('job-1');
    expect(captureProviderCliSnapshot).not.toHaveBeenCalled();
    expect(createAgentContainerLifecycle.mock.calls.at(-1)![0].providerCliSnapshot).toEqual(SAVED_CLI);
  });

  it('treats a legacy job without a visibility field as hidden (spawn_agent default)', async() => {
    // risk: jobs persisted before visibility was recorded still lose their workspace on wake
    const { parkedAgentRehydrator } = await import('../../../services/ParkedAgentRehydrator');
    const state = chatState(THREAD_ID);
    parkedAgentRehydrator.apply(state, parkedIdentity(undefined));

    expect(folderOf(await containerKeyFor('sulla-desktop', THREAD_ID, state))).toBe(ORIGINAL_FOLDER);
  });

  it('keeps the chat key for a visible tab job, which always ran as a chat', async() => {
    // risk: switching tab jobs to the bare thread key would orphan their existing chat workspaces
    const { parkedAgentRehydrator } = await import('../../../services/ParkedAgentRehydrator');
    const state = chatState('tab-thread');
    parkedAgentRehydrator.apply(state, parkedIdentity('tab', 'tab-thread'));

    expect(await containerKeyFor('sulla-desktop', 'tab-thread', state)).toBe('conversation:sulla-desktop:tab-thread');
  });

  it('keeps the channel-scoped key for an ordinary chat thread', async() => {
    // risk: existing chat workspaces move to a new folder and appear empty
    expect(await containerKeyFor('sulla-desktop', 'chat-thread', chatState('chat-thread'))).toBe('conversation:sulla-desktop:chat-thread');
    // A new ordinary root captures the approved worker selection.
    expect(getJob).not.toHaveBeenCalled();
    expect(captureProviderCliSnapshot).toHaveBeenCalledTimes(1);
    expect(createAgentContainerLifecycle.mock.calls.at(-1)![0].providerCliSnapshot).toEqual(CURRENT_CLI);
  });

  it('reuses an ordinary active container and its CLI snapshot after selection changes', async() => {
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype) as any;
    service.conversationContainers = new Map();
    service.activeAborts = new Map();
    service.conversationContainerStarts = new Map();
    const state = chatState('same-chat');

    const first = await service.conversationContainer('sulla-desktop', 'same-chat', 'codex', state);
    // A settings/model change during an active turn must not replace the
    // container or its creation-time CLI snapshot underneath that turn.
    service.activeAborts.set('sulla-desktop|same-chat', {});
    captureProviderCliSnapshot.mockResolvedValueOnce({ ...CURRENT_CLI, codex: { mode: 'versioned', version: '0.171.0' } });
    const second = await service.conversationContainer('sulla-desktop', 'same-chat', 'codex', {
      ...state, metadata: { ...state.metadata, agent: { model: 'gpt-6.2-sol' } },
    });

    expect(second).toBe(first);
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(1);
    expect(captureProviderCliSnapshot).toHaveBeenCalledTimes(1);
    expect(createAgentContainerLifecycle.mock.calls[0][0].providerCliSnapshot).toEqual(CURRENT_CLI);
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });

  it('passes the captured ordinary snapshot through vanished-container recovery', async() => {
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype) as any;
    service.conversationContainers = new Map();
    service.activeAborts = new Map();
    service.conversationContainerStarts = new Map();
    const state = chatState('recover-chat');
    const first = await service.conversationContainer('sulla-desktop', 'recover-chat', 'codex', state);
    const recovery = await service.recoverConversationContainer('sulla-desktop', 'recover-chat', 'codex', state, first);

    expect(recovery).not.toBe(first);
    expect(createAgentContainerLifecycle.mock.calls.at(-1)![0].providerCliSnapshot).toEqual(CURRENT_CLI);
    expect(captureProviderCliSnapshot).toHaveBeenCalledTimes(1);
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });

  it('captures a newly approved snapshot when an idle root launches a replacement container', async() => {
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype) as any;
    service.conversationContainers = new Map();
    service.activeAborts = new Map();
    service.conversationContainerStarts = new Map();
    const state = chatState('replacement-chat');
    const first = await service.conversationContainer('sulla-desktop', 'replacement-chat', 'codex', state);
    const next = { ...CURRENT_CLI, codex: { mode: 'versioned', version: '0.171.0' } };
    captureProviderCliSnapshot.mockResolvedValueOnce(next);

    const replacement = await service.conversationContainer('sulla-desktop', 'replacement-chat', 'codex', {
      ...state, metadata: { ...state.metadata, agent: { model: 'gpt-6.2-sol' } },
    });

    expect(replacement).not.toBe(first);
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(2);
    expect(captureProviderCliSnapshot).toHaveBeenCalledTimes(2);
    expect(createAgentContainerLifecycle.mock.calls.at(-1)![0].providerCliSnapshot).toEqual(next);
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });

  it('shares one lifecycle for a thread dispatched on multiple channels', async() => {
    // risk: a second channel creates a duplicate named Docker container and fails every turn
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype);
    service.conversationContainers = new Map();
    service.conversationContainerStarts = new Map();
    service.activeAborts = new Map();
    const state = chatState('shared-thread');
    const [first, second] = await Promise.all([
      service.conversationContainer('desktop', 'shared-thread', 'codex', state),
      service.conversationContainer('mobile-relay', 'shared-thread', 'codex', state),
    ]);
    expect(first).toBe(second);
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(1);
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });

  it('does not hand a concurrent different agent the lifecycle being created for the first agent', async() => {
    // risk: an agent receives another agent's capability token and Files actor
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype);
    service.conversationContainers = new Map();
    service.conversationContainerStarts = new Map();
    service.activeAborts = new Map();
    let finishFirst!: (lifecycle: any) => void;
    const firstLifecycle = { closed: false, close: vi.fn(async() => {}) };
    const secondLifecycle = { closed: false, close: vi.fn(async() => {}) };
    createAgentContainerLifecycle.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }) as any)
      .mockImplementationOnce(async() => secondLifecycle as any);
    const firstState = chatState('agent-race-thread');
    const first = service.conversationContainer('desktop', 'agent-race-thread', 'codex', firstState);
    const secondState = chatState('agent-race-thread');
    secondState.metadata.agentId = 'different-agent';
    const second = service.conversationContainer('mobile-relay', 'agent-race-thread', 'claude', secondState);
    // conversationContainer awaits a dynamic import before it creates the lifecycle, so wait for the create call to run
    await vi.waitFor(() => expect(typeof finishFirst).toBe('function'));
    finishFirst(firstLifecycle);
    await expect(first).resolves.toBe(firstLifecycle);
    await expect(second).resolves.toBe(secondLifecycle);
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(2);
    expect(service.conversationContainers.get('agent-race-thread').agentId).toBe('different-agent');
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });

  it('closes and removes the idle desktop agent lifecycle before mobile-relay creates its own', async() => {
    // risk: a different agent collides with the idle thread container or inherits its capability
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype);
    service.conversationContainers = new Map();
    service.conversationContainerStarts = new Map();
    service.activeAborts = new Map();
    const events: string[] = [];
    const oldLifecycle = { closed: false, close: vi.fn(async() => { events.push('old-removed'); }) };
    const mobileLifecycle = { closed: false, close: vi.fn(async() => {}) };
    createAgentContainerLifecycle.mockImplementationOnce(async() => { events.push('desktop-created'); return oldLifecycle as any; })
      .mockImplementationOnce(async() => { events.push('mobile-created'); return mobileLifecycle as any; });
    await service.conversationContainer('sulla-desktop', 'mobile-thread', 'codex', chatState('mobile-thread'));
    const mobileState = chatState('mobile-thread');
    mobileState.metadata.agentId = 'mobile-relay';
    await service.conversationContainer('mobile-relay', 'mobile-thread', 'codex', mobileState);
    expect(oldLifecycle.close).toHaveBeenCalledWith('agent-switch', 'BackendGraphWebSocketService.conversationContainer');
    expect(events).toEqual(['desktop-created', 'old-removed', 'mobile-created']);
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(2);
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });

  it('waits for an active desktop turn before replacing its lifecycle for mobile-relay', async() => {
    // risk: switching agent containers while another channel is running kills or lends its lifecycle
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype);
    service.conversationContainers = new Map();
    service.conversationContainerStarts = new Map();
    service.activeAborts = new Map([['sulla-desktop|active-thread', {}]]);
    const oldLifecycle = { closed: false, close: vi.fn(async() => {}) };
    const mobileLifecycle = { closed: false, close: vi.fn(async() => {}) };
    createAgentContainerLifecycle.mockImplementationOnce(async() => oldLifecycle as any)
      .mockImplementationOnce(async() => mobileLifecycle as any);
    await service.conversationContainer('sulla-desktop', 'active-thread', 'codex', chatState('active-thread'));
    const mobileState = chatState('active-thread');
    mobileState.metadata.agentId = 'mobile-relay';
    let finished = false;
    const replacement = service.conversationContainer('mobile-relay', 'active-thread', 'codex', mobileState).then((value: any) => {
      finished = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    expect(oldLifecycle.close).not.toHaveBeenCalled();
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(1);
    service.activeAborts.delete('sulla-desktop|active-thread');
    await expect(replacement).resolves.toBe(mobileLifecycle);
    expect(oldLifecycle.close).toHaveBeenCalledTimes(1);
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(2);
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });

  it('does not close or recreate an in-use lifecycle for a same-agent provider switch', async() => {
    // risk: a provider fallback kills the existing run container while another turn holds it
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype);
    service.conversationContainers = new Map();
    service.conversationContainerStarts = new Map();
    service.activeAborts = new Map([['desktop|provider-switch-thread', {}]]);
    const state = chatState('provider-switch-thread');
    await service.conversationContainer('desktop', 'provider-switch-thread', 'codex', state);
    const existing = service.conversationContainers.get('provider-switch-thread').lifecycle;
    await service.conversationContainer('desktop', 'provider-switch-thread', 'claude', state);
    expect(service.conversationContainers.get('provider-switch-thread').lifecycle).toBe(existing);
    expect(existing.close).not.toHaveBeenCalled();
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(1);
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });
});
