// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAgentContainerLifecycle } = vi.hoisted(() => ({
  createAgentContainerLifecycle: vi.fn((_run: any) => Promise.resolve({ closed: false, close: vi.fn(() => Promise.resolve()) })),
}));
vi.mock('../../../services/AgentContainerLauncher', () => ({ createAgentContainerLifecycle }));
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
  beforeEach(() => createAgentContainerLifecycle.mockClear());

  it('reuses the spawn_agent workspace folder when a hidden delegated thread is woken after a restart', async() => {
    // risk: a woken worker gets a brand-new empty workspace and loses its clone and CLI session state
    const { parkedAgentRehydrator } = await import('../../../services/ParkedAgentRehydrator');
    const { delegatedThreadPersistenceKey } = await import('../../../services/DelegatedContainerKey');
    const state = chatState(THREAD_ID);
    parkedAgentRehydrator.apply(state, parkedIdentity('hidden'));

    const key = await containerKeyFor('sulla-desktop', THREAD_ID, state);

    expect(key).toBe(delegatedThreadPersistenceKey(THREAD_ID));
    expect(folderOf(key)).toBe(ORIGINAL_FOLDER);
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
  });

  it('shares one lifecycle for a thread dispatched on multiple channels', async() => {
    // risk: a second channel creates a duplicate named Docker container and fails every turn
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service = Object.create(BackendGraphWebSocketService.prototype);
    service.conversationContainers = new Map();
    service.conversationContainerStarts = new Map();
    service.activeAborts = new Map();
  service.conversationContainerStarts = new Map();
    const state = chatState('shared-thread');
    const [first, second] = await Promise.all([
      service.conversationContainer('desktop', 'shared-thread', 'codex', state),
      service.conversationContainer('mobile-relay', 'shared-thread', 'codex', state),
    ]);
    expect(first).toBe(second);
    expect(createAgentContainerLifecycle).toHaveBeenCalledTimes(1);
    for (const entry of service.conversationContainers.values()) clearTimeout(entry.idleTimer);
  });
});
