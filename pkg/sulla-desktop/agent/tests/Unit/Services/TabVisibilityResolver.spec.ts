// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { JobLineageRootChatThreadFinder, TabVisibilityResolver, type TabVisibilityFacts } from '../../../services/TabVisibilityResolver';

const readyFacts = (overrides: Partial<TabVisibilityFacts> = {}): TabVisibilityFacts => ({
  requested: 'tab', parentThreadId: 'human-chat', callerIsHiddenJob: false, agentRoutable: true, tabLaunchEnabled: true, callerThreadId: 'human-chat', ...overrides,
});

describe('TabVisibilityResolver', () => {
  it('opens the tab when the human chat is the caller and everything is routable', async() => {
    // risk: a valid visible request must not be silently downgraded
    const decision = await new TabVisibilityResolver({ findRootChatThreadId: async() => undefined }).resolve(readyFacts());
    expect(decision).toEqual({ visibility: 'tab', requestedVisibility: 'tab' });
  });

  it('never downgrades silently: a tab request with no active chat thread carries the reason', async() => {
    // risk: the caller is told nothing and believes a visible tab opened
    const decision = await new TabVisibilityResolver({ findRootChatThreadId: async() => undefined })
      .resolve(readyFacts({ parentThreadId: undefined, callerThreadId: undefined }));
    expect(decision).toEqual({ visibility: 'hidden', requestedVisibility: 'tab', downgradeReason: 'no_active_chat_thread' });
  });

  it('opens a hidden caller\'s tab in the root human chat when one exists', async() => {
    // risk: a hidden parent's tab request is lost even though a human window is available
    const decision = await new TabVisibilityResolver({ findRootChatThreadId: async(thread) => (thread === 'hidden-child-thread' ? 'human-chat' : undefined) })
      .resolve(readyFacts({ callerIsHiddenJob: true, parentThreadId: 'hidden-child-thread', callerThreadId: 'hidden-child-thread' }));
    expect(decision).toEqual({ visibility: 'tab', requestedVisibility: 'tab', tabParentThreadId: 'human-chat' });
  });

  it('keeps a hidden caller hidden with its reason when no root human chat exists', async() => {
    // risk: a hidden caller with nowhere to show the tab must still say why it ran hidden
    const decision = await new TabVisibilityResolver({ findRootChatThreadId: async() => undefined })
      .resolve(readyFacts({ callerIsHiddenJob: true, parentThreadId: 'hidden-child-thread', callerThreadId: 'hidden-child-thread' }));
    expect(decision).toEqual({ visibility: 'hidden', requestedVisibility: 'tab', downgradeReason: 'caller_is_hidden_job' });
  });

  it('refuses a tab for an agent that is not routable, and when tab launch is disabled', async() => {
    // risk: a tab for an unknown or disabled agent opens an empty or wrong persona
    const resolver = new TabVisibilityResolver({ findRootChatThreadId: async() => undefined });
    expect(await resolver.resolve(readyFacts({ agentRoutable: false }))).toEqual({ visibility: 'hidden', requestedVisibility: 'tab', downgradeReason: 'agent_not_routable' });
    expect(await resolver.resolve(readyFacts({ tabLaunchEnabled: false }))).toEqual({ visibility: 'hidden', requestedVisibility: 'tab', downgradeReason: 'tab_launch_disabled' });
  });

  it('leaves hidden requests untouched', async() => {
    // risk: hidden is the default; adding a downgrade field to it would confuse every caller
    expect(await new TabVisibilityResolver({ findRootChatThreadId: async() => undefined }).resolve(readyFacts({ requested: undefined }))).toEqual({ visibility: 'hidden' });
  });
});

describe('JobLineageRootChatThreadFinder', () => {
  it('walks job parent links up to the top-level chat thread', async() => {
    // risk: a deep hidden child opens its tab under a middle manager thread instead of the human chat
    // Threads owned by a job map to that job's parent thread; the human chat has no owning job.
    const ownerJobParent: Record<string, string> = { 'grandchild-thread': 'child-thread', 'child-thread': 'human-chat' };
    const finder = new JobLineageRootChatThreadFinder(async(threadId) => (ownerJobParent[threadId]
      ? { job: { parentThreadId: ownerJobParent[threadId] } } : undefined));
    expect(await finder.findRootChatThreadId('grandchild-thread')).toBe('human-chat');
  });

  it('stops on a parent cycle instead of looping forever', async() => {
    // risk: corrupt parent links hang the spawn call
    const finder = new JobLineageRootChatThreadFinder(async() => ({ job: { parentThreadId: 'a' } }));
    expect(await finder.findRootChatThreadId('a')).toBeUndefined();
  });
});
