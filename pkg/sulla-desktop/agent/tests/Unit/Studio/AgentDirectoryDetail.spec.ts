// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AgentDirectoryTab from '@pkg/components/studio/AgentDirectoryTab.vue';
import type { AgentDefinitionResponse } from '@pkg/main/agentsIpc';

function agent(patch: Partial<AgentDefinitionResponse> = {}): AgentDefinitionResponse {
  return {
    id:                 'product-owner-id',
    slug:               'product-owner',
    name:               'Product Owner',
    description:        'Plans work and coordinates the AI team.',
    provider:           null,
    model:              null,
    modelSlot:          'primary',
    modelChoice:        { mode: 'list' },
    prompt:             'Coordinate the team and preserve acceptance criteria.',
    sourceKind:         'builtin',
    marketplaceVersion: null,
    status:             'production',
    enabled:            true,
    runLocation:        'container',
    whenToCall:         'Use for product work that needs planning and delegation.',
    whenNotToCall:      'Do not use for a single factual lookup.',
    send:               'Goal, constraints, and relevant project context.',
    returns:            'A verified outcome with evidence.',
    costTier:           'high',
    canCall:            ['builder'],
    isBuiltin:          true,
    frontDoor:          true,
    allowedTools:       ['github/create_pull_request', 'files/read'],
    skillRefs:          ['product-planning', 'release-review'],
    routineRefs:        ['acceptance-checks'],
    updatedAt:          '2026-11-20T18:00:00.000Z',
    type:               'lead',
    ...patch,
  };
}

function openProfile() {
  const agents = [
    agent(),
    agent({
      id:           'builder-id',
      slug:         'builder',
      name:         'Builder',
      description:  'Implements scoped work.',
      prompt:       'Build the saved implementation.',
      canCall:      ['reviewer'],
      allowedTools: [],
      skillRefs:    [],
      routineRefs:  [],
      type:         'worker',
      frontDoor:    false,
    }),
    agent({
      id:           'reviewer-id',
      slug:         'reviewer',
      name:         'Code Reviewer',
      description:  'Reviews the saved implementation.',
      prompt:       'Review the exact saved implementation.',
      canCall:      [],
      allowedTools: [],
      skillRefs:    [],
      routineRefs:  [],
      type:         'worker',
      frontDoor:    false,
    }),
  ];
  const wrapper = mount(AgentDirectoryTab, {
    props: {
      agents,
      loading:     false,
      search:      '',
      modelLabels: {
        'product-owner': 'Claude Opus · Default',
        builder:         'GPT-6.2-Sol · Medium',
        reviewer:        'GPT-6.2-Astra · High',
      },
      modelRoutes: {
        'product-owner': ['Tier 1 · Claude Opus · Default', 'Tier 2 · GPT-6.2-Astra · High'],
        builder:         ['Tier 1 · GPT-6.2-Sol · Medium', 'Tier 2 · Claude Sonnet · High'],
        reviewer:        ['Tier 1 · GPT-6.2-Astra · High'],
      },
    },
  });
  return { wrapper, agents };
}

describe('agent directory profile details', () => {
  it('shows the saved prompt, capabilities, complete model route, and callable team', async() => {
    const { wrapper } = openProfile();
    await wrapper.find('button[aria-label="Open Product Owner"]').trigger('click');

    const text = wrapper.text();
    expect(text).toContain('Full configuration');
    expect(text).toContain('Coordinate the team and preserve acceptance criteria.');
    expect(text).toContain('github/create_pull_request');
    expect(text).toContain('files/read');
    expect(text).toContain('product-planning');
    expect(text).toContain('release-review');
    expect(text).toContain('acceptance-checks');
    expect(text).toContain('Tier 1 · Claude Opus · Default');
    expect(text).toContain('Tier 2 · GPT-6.2-Astra · High');
    expect(text).toContain('Builder');
    expect(text).toContain('Tier 1 · GPT-6.2-Sol · Medium');
    expect(text).toContain('Tier 2 · Claude Sonnet · High');
    expect(text).toContain('Code Reviewer');
    expect(text).toContain('via Builder');
    expect(text).toContain('Tier 1 · GPT-6.2-Astra · High');
  });

  it('keeps Edit as the only mutation path from the read-only profile', async() => {
    const { wrapper, agents } = openProfile();
    await wrapper.find('button[aria-label="Open Product Owner"]').trigger('click');
    await wrapper.find('header .btn.pri').trigger('click');

    expect(wrapper.emitted('edit')).toEqual([[agents[0]]]);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.find('textarea').exists()).toBe(false);
  });
});
