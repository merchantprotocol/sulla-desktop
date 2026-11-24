// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

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

import { resolveLaunchModelPrecedence } from '../../../languagemodels/modelPrecedence';
import { TurnProviderResolver } from '../../../nodes/TurnProviderResolver';
import { ThreadModelOverridePolicy } from '../../../services/ThreadModelOverridePolicy';

const mapping = {
  version: 1 as const, slug: 'worker', agentId: 'worker-id', revision: 1, selected: 0,
  candidates: [{ provider: 'codex', model: 'gpt-6.2-sol' }],
};

describe('launch model precedence', () => {
  it('uses a provider/model override ahead of a saved worker mapping', () => {
    // risk: an owner-selected model silently runs the saved worker mapping instead
    const decision = resolveLaunchModelPrecedence({
      override: { provider: 'claude-code', model: 'claude-opus-5-5' },
      workerModelRoute: mapping,
    });
    expect(decision).toMatchObject({ step: 'override', requested: { provider: 'claude-code', model: 'claude-opus-5-5' }, choice: { mode: 'pin', provider: 'claude-code', model: 'claude-opus-5-5' } });
    expect(decision.workerModelRoute).toBeUndefined();
  });

  it.each([
    { provider: 'claude-code' },
    { model: 'o3' },
  ])('rejects incomplete or unrecognized overrides instead of falling through: %o', override => {
    // risk: unavailable exact choice silently becomes the thread or worker model
    expect(() => resolveLaunchModelPrecedence({ override })).toThrow('Requested model');
  });

  it('records that mapping precedence ignores an effort-only request', () => {
    // risk: the job claims to have honored an effort that routing discarded
    expect(resolveLaunchModelPrecedence({ override: { effort: 'max' }, workerModelRoute: mapping })).toMatchObject({
      step: 'agent-mapping', reason: expect.stringContaining('effort was ignored'),
    });
  });

  it('uses the agent pin without an override and otherwise defers to the category', () => {
    // risk: agent programming loses to a global/thread default
    expect(resolveLaunchModelPrecedence({ agentChoice: { mode: 'pin', provider: 'codex', model: 'gpt-6.2-sol' } }))
      .toMatchObject({ step: 'agent-pin', requested: { provider: 'codex', model: 'gpt-6.2-sol' } });
    expect(resolveLaunchModelPrecedence({ agentChoice: { mode: 'class', class: 'coding' } }))
      .toMatchObject({ step: 'category', requested: null });
  });

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
});
