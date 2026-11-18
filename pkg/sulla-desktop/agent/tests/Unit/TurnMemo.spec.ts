// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { TurnProviderMemo } from '../../nodes/turnProviderMemo';
import { TurnAgentDefinitionMemo } from '../../nodes/turnAgentDefinitionMemo';
import type { BaseThreadState } from '../../nodes/Graph';

function state(): BaseThreadState {
  return { messages: [{ role: 'user', content: 'first turn' } as any], metadata: { threadId: 'thread', action: 'direct_answer', wsChannel: 'sulla', llmModel: '', llmLocal: false } as any };
}

describe('turn-scoped agent routing memo', () => {
  it('reuses one provider resolution across prompt enrichment and subconscious detection', async () => {
    // risk: repeated provider discovery blocks the first model call on every graph turn
    const memo = new TurnProviderMemo();
    const thread = state();
    const provider = { getProviderName: () => 'anthropic' } as any;
    const resolve = vi.fn(async () => provider);
    const candidates = [{ provider: 'anthropic', model: 'claude' }];
    memo.set(thread, await resolve(), candidates);
    expect(memo.get(thread)?.provider).toBe(provider);
    expect(memo.get(thread)?.candidates).toEqual(candidates);
    expect(resolve).toHaveBeenCalledTimes(1);
    thread.messages.push({ role: 'user', content: 'next turn' } as any);
    expect(memo.get(thread)).toBeUndefined();
  });

  it('forgets the memoized provider for the same user message after clear', () => {
    // risk: a failed provider stays first for later tool-loop iterations, skipping health-ordered re-resolution
    const memo = new TurnProviderMemo();
    const thread = state();
    memo.set(thread, { getProviderName: () => 'anthropic' } as any, [{ provider: 'anthropic', model: 'claude' }]);
    expect(memo.get(thread)).toBeDefined();
    memo.clear(thread);
    expect(memo.get(thread)).toBeUndefined();
  });

  it('deduplicates the agent definition read across a turn and refreshes on the next message', async () => {
    // risk: repeated database reads saturate the shared PostgreSQL pool during graph fan-out
    const memo = new TurnAgentDefinitionMemo<{ model_choice: string }>();
    const thread = state();
    const load = vi.fn(async () => ({ model_choice: 'fast' }));
    const first = memo.get(thread, 'agent', load);
    const second = memo.get(thread, 'agent', load);
    expect(await first).toEqual({ model_choice: 'fast' });
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    thread.messages.push({ role: 'user', content: 'next turn' } as any);
    await memo.get(thread, 'agent', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
