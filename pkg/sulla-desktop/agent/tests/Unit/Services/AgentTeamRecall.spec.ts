// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../tools/agents/jobRegistry', () => ({ MAX_SUBAGENT_DEPTH: 3 }));
import { AgentTeamRecallService } from '../../../services/AgentTeamRecall';
import type { AgentDirectoryCard } from '../../../services/AgentDirectoryService';

// Directory card line, with or without the "fits right now" marker; avoids matching prompt prose.
const cardLine = (slug: string) => new RegExp(`^- (\\*\\*fits right now\\*\\* · )?${ slug }$`, 'm');

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

  it('queries the index first and fetches directory cards only for the returned slugs', async() => {
    // risk: cross-agent invocation — directory must not receive or render callees the index did not select
    const query = vi.fn(async() => [
      { type: 'agent' as const, slug: 'allowed', title: 'Allowed', description: 'A', score: 0.5, reason: 'semantic match' },
    ]);
    const listDirectory = vi.fn(async(slugs: string[]) => slugs.map(card));
    const service = new AgentTeamRecallService(
      { query },
      async() => ({ slug: 'lead', can_call: ['allowed', 'other', 'lead'], prompt_content: '', system_prompt: '', prompt_files: {} } as any),
      listDirectory,
      candidate => `- ${candidate.slug}\n  ${candidate.description}`,
    );
    const context = await service.buildContext({ agentSlug: 'lead', text: 'need help' });
    expect(query).toHaveBeenCalledWith('need help', { types: ['agent'], allowedSlugs: ['allowed', 'other'], limit: 50 });
    expect(listDirectory).toHaveBeenCalledTimes(1);
    expect(listDirectory).toHaveBeenCalledWith(['allowed']);
    expect(context).toMatch(cardLine('allowed'));
    expect(context).not.toMatch(cardLine('other'));
    expect(context).not.toMatch(cardLine('lead'));
  });

  it('applies no slug restriction for a wildcard can_call but still excludes the lead itself', async() => {
    // risk: self-invocation loops — wildcard grants any callee, never the lead
    const query = vi.fn(async() => [
      { type: 'agent' as const, slug: 'lead', title: 'Lead', description: 'L', score: 0.9, reason: 'semantic match' },
      { type: 'agent' as const, slug: 'anyone', title: 'Anyone', description: 'N', score: 0.4, reason: 'semantic match' },
    ]);
    const listDirectory = vi.fn(async(slugs: string[]) => slugs.map(card));
    const service = new AgentTeamRecallService(
      { query },
      async() => ({ slug: 'lead', can_call: ['*'], prompt_content: '', system_prompt: '', prompt_files: {} } as any),
      listDirectory,
      candidate => `- ${candidate.slug}`,
    );
    const context = await service.buildContext({ agentSlug: 'lead', text: 'need help' });
    expect(query).toHaveBeenCalledWith('need help', { types: ['agent'], limit: 50 });
    expect(listDirectory).toHaveBeenCalledWith(['anyone']);
    expect(context).toMatch(cardLine('anyone'));
    expect(context).not.toMatch(cardLine('lead'));
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
