// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ find: vi.fn(), list: vi.fn(), editable: vi.fn() }));
vi.mock('@pkg/agent/services/AgentDefinitionService', () => ({
  agentDefinitionService: { findBySlug: f.find, list: f.list },
}));
vi.mock('@pkg/agent/languagemodels/modelRouter', () => ({
  modelRouter: { getEditableState: f.editable },
}));

import { buildAgentTeamBlock } from '@pkg/agent/services/AgentDirectoryService';

beforeEach(() => {
  f.find.mockReset(); f.list.mockReset(); f.editable.mockReset();
  f.editable.mockResolvedValue({ workerBindings: {} });
  f.list.mockResolvedValue([{
    id: 'agent-other', slug: 'codex-worker', name: 'Codex worker', description: 'Implements code',
    when_to_call: 'When code needs implementing.', when_not_to_call: '', send: '', returns: '',
    cost_tier: 'medium', can_call: [], front_door: false, provider: 'codex', model: 'gpt-6-sol',
    model_slot: 'secondary', model_choice: { mode: 'list' }, is_builtin: true, enabled: true, status: 'production',
  }]);
});

describe('AgentDirectoryService awareness gate', () => {
  it('does not build an <agent_team> prompt block for a worker that opted out', async() => {
    // risk: a direct prompt-building caller bypasses the middleware and exposes the callable-agent directory.
    f.find.mockResolvedValue({ slug: 'worker', can_call: ['*'], agent_awareness: false });
    expect(await buildAgentTeamBlock({ forAgentSlug: 'worker' })).toBe('');
    expect(f.list).not.toHaveBeenCalled();
  });

  it('keeps the team block unchanged for an aware lead', async() => {
    // risk: managers lose the team directory they rely on after the new default is introduced.
    f.find.mockResolvedValue({ slug: 'lead', can_call: ['*'], agent_awareness: true });
    const block = await buildAgentTeamBlock({ forAgentSlug: 'lead' });
    expect(block).toContain('<agent_team>');
    expect(block).toContain('codex-worker');
  });
});
