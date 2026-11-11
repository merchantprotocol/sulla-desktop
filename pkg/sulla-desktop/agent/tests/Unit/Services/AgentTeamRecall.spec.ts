// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../tools/agents/jobRegistry', () => ({ MAX_SUBAGENT_DEPTH: 3 }));
import { AgentTeamRecallService } from '../../../services/AgentTeamRecall';
import type { AgentDirectoryCard } from '../../../services/AgentDirectoryService';

const card = (slug: string): AgentDirectoryCard => ({
  slug, name: slug, description: `${slug} description`, whenToCall: '', whenNotToCall: '', send: '', returns: '',
  costTier: null, canCall: [], frontDoor: false, provider: null, model: null, modelSlot: null, builtin: false, enabled: true, status: 'active',
});

describe('AgentTeamRecallService', () => {
  it('ranks only published suggestions within the lead can_call allowlist', async() => {
    // risk: cross-agent invocation — suggestions must not escape the caller's explicit permission list
    const query = vi.fn(async() => [
      { type: 'agent' as const, slug: 'allowed', title: 'Allowed', description: 'Allowed agent', score: 0.03, reason: 'semantic match' },
      { type: 'agent' as const, slug: 'forbidden', title: 'Forbidden', description: 'Forbidden agent', score: 0.04, reason: 'semantic match' },
    ]);
    const service = new AgentTeamRecallService(
      { query },
      async() => ({ slug: 'lead', can_call: ['allowed'], prompt_content: '', system_prompt: '', prompt_files: {} } as any),
      async() => [card('allowed'), card('forbidden')],
      candidate => `- ${candidate.slug}\n  ${candidate.description}`,
    );
    const context = await service.buildContext({ agentSlug: 'lead', text: 'need help', depth: 1 });
    expect(query).toHaveBeenCalledWith('need help', { types: ['agent'], allowedSlugs: ['allowed'], limit: 50 });
    expect(context).toContain('allowed');
    expect(context).not.toContain('forbidden');
    expect(context).toContain('sub-agent depth 1');
  });

  it('does not include directory entries absent from the published suggestion index', async() => {
    // risk: draft/unpublished agents must never enter agent context
    const service = new AgentTeamRecallService(
      { query: async() => [] },
      async() => ({ slug: 'lead', can_call: ['draft-agent'], prompt_content: '', system_prompt: '', prompt_files: {} } as any),
      async() => [card('draft-agent')],
      candidate => `- ${candidate.slug}`,
    );
    expect(await service.buildContext({ agentSlug: 'lead', text: 'anything' })).toBe('');
  });
});
