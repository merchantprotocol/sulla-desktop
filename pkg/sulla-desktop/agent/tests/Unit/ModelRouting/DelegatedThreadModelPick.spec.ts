// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ resolve: vi.fn(async() => ({
  candidates: [{ provider: 'claude-code', model: 'claude-opus-5-5' }],
  service: { getModel: () => 'claude-opus-5-5' },
})) }));

vi.mock('../../../languagemodels', () => ({
  modelRouteService: { resolve: f.resolve },
  getPrimaryService: vi.fn(),
  getSubconsciousService: vi.fn(),
}));
vi.mock('../../../services/AgentDefinitionService', () => ({
  agentDefinitionService: { findBySlug: async() => ({ model_choice: { mode: 'pin', provider: 'codex', model: 'gpt-6.2-sol' } }) },
}));

import { TurnProviderResolver } from '../../../nodes/TurnProviderResolver';
import { ThreadModelOverridePolicy } from '../../../services/ThreadModelOverridePolicy';

beforeEach(() => f.resolve.mockClear());

describe('delegated thread chat model picker', () => {
  it('uses an explicit pick on the next delegated turn instead of the saved agent mapping', async() => {
    // risk: a delegated worker's saved mapping masks the human's explicit chat model selection
    const policy = new ThreadModelOverridePolicy();
    const selection = policy.parse({ providerId: 'claude-code', modelId: 'claude-opus-5-5' });
    const agent = policy.apply({ provider: 'codex', model: 'gpt-6.2-sol' }, selection);
    const state: any = {
      metadata: {
        threadId: 'delegated-thread', agentId: 'worker', delegatedJobId: 'job',
        modelSlot: 'primary', workerModelChatOverride: true,
        workerModelRoute: { version: 1, selected: 0, connections: { codex: 'saved' }, candidates: [{ provider: 'codex', model: 'gpt-6.2-sol' }] },
        agent,
      },
      messages: [{ role: 'user', content: 'next turn' }],
    };

    await new TurnProviderResolver().resolve(state);

    expect(f.resolve).toHaveBeenCalledWith('agents', { mode: 'pin', provider: 'claude-code', model: 'claude-opus-5-5' });
  });

  it('passes the stored agent effort through provider resolution', async() => {
    // risk: a requested Codex effort is dropped and the default reasoning level runs
    const state: any = {
      metadata: { threadId: 'effort-thread', agentId: 'worker', modelSlot: 'primary', agent: { provider: 'codex', model: 'gpt-6.2-sol', effort: 'max' } },
      messages: [{ role: 'user', content: 'next turn' }],
    };
    await new TurnProviderResolver().resolve(state);
    expect(f.resolve).toHaveBeenCalledWith('agents', { mode: 'pin', provider: 'codex', model: 'gpt-6.2-sol', effort: 'max' });
  });
});
