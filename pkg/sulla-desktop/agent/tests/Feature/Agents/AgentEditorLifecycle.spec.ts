/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  editorProfileSignature,
  editorFormFromAgent,
  editorPatchFromForm,
  emptyAgentEditorForm,
} from '@pkg/components/studio/AgentEditorForm';
import StudioAgentsPage from '@pkg/components/studio/StudioAgentsPage.vue';
import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import {
  matchesQuery,
  teamScopeLabel,
} from '@pkg/components/studio/agentDirectory';
import {
  agentEditorTeamLabel,
  agentTryTabPayload,
} from '@pkg/shared/agentEditor';

const f = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: { invoke: f.invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));
vi.mock('@pkg/composables/useDatabaseAvailableReload', () => ({
  useDatabaseAvailableReload: () => {},
}));
const agent = {
  id:                 'agent-1',
  slug:               'reviewer',
  name:               'Reviewer',
  description:        'Reviews artifacts.',
  provider:           'grok',
  model:              null,
  modelSlot:          'secondary',
  modelChoice:        { mode: 'class', class: 'fast' },
  prompt:             'Review the artifact.',
  sourceKind:         'local',
  marketplaceVersion: null,
  status:             'production',
  enabled:            true,
  runLocation:        'container',
  whenToCall:         'When review is needed.',
  whenNotToCall:      'Not for execution.',
  send:               'Artifact and criteria.',
  returns:            'Findings.',
  costTier:           'medium',
  canCall:            [],
  isBuiltin:          false,
  frontDoor:          true,
  updatedAt:          '2026-11-18T18:00:00.123Z',
  type:               'worker',
  allowedTools:       ['artifact_read'],
  skillRefs:          ['missing/skill'],
  routineRefs:        ['routine.review'],
};

const routing = {
  workers:             [{ id: 'agent-1', slug: 'reviewer' }],
  workerBindings:      {},
  providers:           [],
  agentsList:          [],
  subconsciousList:    [],
  classes:             { frontier: [], standard: [], fast: [], coding: [], local: [] },
  followProviderOrder: {},
  neverUse:            [],
};

describe('agent editor lifecycle contract', () => {
  beforeEach(() => {
    f.invoke.mockReset();
    f.invoke.mockImplementation((name: string) => {
      if (name === 'agent-definitions:list') return Promise.resolve([structuredClone(agent)]);
      if (name === 'agent-definitions:export') {
        return Promise.resolve({
          spec: { skills: ['missing/skill'], tools: ['artifact_read'] },
        });
      }
      if (name === 'model-routing:get') return Promise.resolve(structuredClone(routing));
      if (name === 'library-list-skills') return Promise.resolve([]);
      if (name === 'tools-list-by-category') return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips routing, capability refs, paused state, and unknown references without dropping fields or model snapshots', () => {
    const form = editorFormFromAgent(agent as any);
    expect(editorPatchFromForm(form)).toMatchObject({
      whenToCall:   'When review is needed.',
      canCall:      [],
      enabled:      true,
      allowedTools: ['artifact_read'],
      skillRefs:    ['missing/skill'],
      routineRefs:  ['routine.review'],
    });
    expect(editorProfileSignature(form)).toBe(editorProfileSignature(editorFormFromAgent(agent as any)));
    expect(editorPatchFromForm(form)).not.toHaveProperty('modelChoice');
    const blank = emptyAgentEditorForm();
    expect(blank.canCall).toEqual([]);
    expect(blank.allowedTools).toEqual([]);
  });

  it('uses the same default-team label in editor and directory semantics', () => {
    expect(agentEditorTeamLabel([])).toBe('Default team · unrestricted');
    expect(teamScopeLabel([])).toBe('Default team · unrestricted');
    expect(matchesQuery(agent as any, 'artifact and criteria')).toBe(true);
  });

  it('saves a team member through its existing worker mapping without changing the owner routing card', async() => {
    const owner = { ...agent, id: 'owner-1', slug: 'account-manager', name: 'Product Owner', canCall: ['builder'] };
    const builder = { ...agent, id: 'builder-1', slug: 'builder', name: 'Builder', canCall: [], modelChoice: { mode: 'class', class: 'coding' } };
    const savedTiers = { version: 1, tiers: [{ candidates: [{ provider: 'codex', model: 'gpt-6.2-sol', effort: 'medium' }] }], crossCompanyFallback: true, allowLaunchOverride: 'listed' };
    let currentRouting: any = {
      ...routing,
      workers: [{ id: owner.id, slug: owner.slug }, { id: builder.id, slug: builder.slug }],
      workerBindings: { builder: { agentId: builder.id, revision: 1, editToken: 'builder-token', candidates: savedTiers.tiers[0].candidates, modelTiers: savedTiers } },
      providers: [{ id: 'codex', name: 'OpenAI Codex', connected: true, local: false, subscription: true, status: 'ready', coolingUntil: null, lastError: null,
        models: [{ id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', efforts: [{ id: 'medium' }, { id: 'high' }] }] }],
    };
    f.invoke.mockImplementation((name: string, ...args: any[]) => {
      if (name === 'agent-definitions:list') return Promise.resolve([structuredClone(owner), structuredClone(builder)]);
      if (name === 'agent-definitions:export') return Promise.resolve({ spec: { skills: [], tools: [] } });
      if (name === 'model-routing:get') return Promise.resolve(structuredClone(currentRouting));
      if (name === 'model-routing:worker-set') {
        currentRouting = { ...currentRouting, workerBindings: { ...currentRouting.workerBindings, builder: {
          ...currentRouting.workerBindings.builder, revision: 2, editToken: 'next-token', candidates: args[0].modelTiers.tiers.flatMap((tier: any) => tier.candidates), modelTiers: args[0].modelTiers,
        } } };
        return Promise.resolve(structuredClone(currentRouting));
      }
      if (name === 'agent-definitions:update') return Promise.resolve({ updated_at: '2026-11-20T18:00:00.000Z' });
      if (name === 'model-routing:preview') return Promise.resolve({ status: 'ready', candidates: [] });
      if (name === 'library-list-skills' || name === 'tools-list-by-category') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const wrapper = mount(StudioAgentsPage, { global: { stubs: {
      StudioTopbar: { template: '<div />' },
      AgentDirectoryTab: { props: ['agents'], emits: ['edit'], template: '<button @click="$emit(\'edit\', agents[0])">Edit owner</button>' },
    } } });
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === 'Edit owner')!.trigger('click');
    await wrapper.findAll('button').find(button => button.text() === 'Team')!.trigger('click');
    await wrapper.find('[aria-label="Tier 1, model 1 effort"]').setValue('high');
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click');
    await flushPromises();
    const saved = f.invoke.mock.calls.find(call => call[0] === 'model-routing:worker-set');
    expect(saved?.[1]).toMatchObject({ slug: 'builder', agentId: builder.id, expectedRevision: 1, expectedToken: 'builder-token',
      modelTiers: { tiers: [{ candidates: [{ provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' }] }] } });
    const ownerUpdate = f.invoke.mock.calls.find(call => call[0] === 'agent-definitions:update');
    expect(ownerUpdate?.[2].canCall).toEqual(['builder']);
    expect(ownerUpdate?.[2]).not.toHaveProperty('modelTiers');
    expect(wrapper.find('.team-shell').exists()).toBe(true);
    wrapper.unmount();
  });

  it('sends all editable routing and capability fields through the existing update IPC', async() => {
    const wrapper = mount(StudioAgentsPage, {
      global: {
        stubs: {
          StudioTopbar:      { template: '<div />' },
          AgentDirectoryTab: { props: ['agents'], emits: ['edit'], template: '<button @click="$emit(\'edit\', agents[0])">Edit reviewer</button>' },
        },
      },
    });
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === 'Edit reviewer')!.trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === 'Routing')!.trigger('click');
    const routingFields = wrapper.findAll('textarea');
    await routingFields[0].setValue('Updated when');
    await routingFields[1].setValue('Updated not when');
    await routingFields[2].setValue('Updated send');
    await routingFields[3].setValue('Updated returns');
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click');
    await flushPromises();
    const update = f.invoke.mock.calls.find(call => call[0] === 'agent-definitions:update');
    expect(update?.[2]).toMatchObject({
      whenToCall:        'Updated when',
      whenNotToCall:     'Updated not when',
      send:              'Updated send',
      returns:           'Updated returns',
      enabled:           true,
      allowedTools:      ['artifact_read'],
      skillRefs:         ['missing/skill'],
      routineRefs:       ['routine.review'],
      canCall:           [],
      expectedUpdatedAt: agent.updatedAt,
    });
    wrapper.unmount();
  });

  it('opens Try as a separate empty normal chat with only the saved agent selected', async() => {
    const events: CustomEvent[] = [];
    const onNavigate = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener('sulla:navigate-tab', onNavigate);
    const wrapper = mount(StudioAgentsPage, {
      global: {
        stubs: {
          StudioTopbar:      { template: '<div><slot name="actions" /></div>' },
          AgentDirectoryTab: {
            props: ['agents'],
            emits: ['edit'],
            template:
              '<button @click="$emit(\'edit\', agents[0])">Edit reviewer</button>',
          },
        },
      },
    });
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Edit reviewer')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.findAll('button').filter((button) => button.text() === 'Try')).toHaveLength(1);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Try')!
      .trigger('click');
    // Chat selection, the persona picker and runtime routing all key agents by slug, not definition id.
    expect(events).toHaveLength(1);
    const openedChat = useBrowserTabs().getTab(events[0].detail.tabId);
    expect(openedChat).toMatchObject({
      url:            'about:blank',
      mode:           'chat',
      title:          'Reviewer · Chat',
      initialAgentId: 'reviewer',
    });
    expect(agentTryTabPayload('reviewer', 'Reviewer · Chat').initialAgentId).toBe('reviewer');
    expect(openedChat).not.toHaveProperty('agentChat');
    window.removeEventListener('sulla:navigate-tab', onNavigate);
    wrapper.unmount();
  });

  it('keeps profile and prompt edits dirty when routing recovers after the editor opened', async() => {
    vi.useFakeTimers();
    const original = f.invoke.getMockImplementation()!;
    let routingDown = true;
    f.invoke.mockImplementation((name, ...args) =>
      name === 'model-routing:get' && routingDown
        ? Promise.reject(new Error('Database unavailable'))
        : original(name, ...args),
    );
    const wrapper = mount(StudioAgentsPage, {
      global: {
        stubs: {
          StudioTopbar:      { template: '<div />' },
          AgentDirectoryTab: {
            props: ['agents'],
            emits: ['edit'],
            template:
              '<button @click="$emit(\'edit\', agents[0])">Edit reviewer</button>',
          },
        },
      },
    });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Edit reviewer')!.trigger('click');
    await wrapper.findAll('.frow input')[0].setValue('Draft profile');
    await wrapper.findAll('button').find((button) => button.text() === 'Prompt')!.trigger('click');
    await wrapper.find('textarea.editor').setValue('Draft prompt');

    routingDown = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.findAll('button').find((button) => button.text() === 'Profile')!.trigger('click');

    const tryButton = wrapper.findAll('button').find((button) => button.text() === 'Try');
    expect(tryButton?.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Save or discard edits before trying it.');
    expect((wrapper.findAll('.frow input')[0].element as HTMLInputElement).value).toBe('Draft profile');
    await wrapper.findAll('button').find((button) => button.text() === 'Prompt')!.trigger('click');
    expect((wrapper.find('textarea.editor').element as HTMLTextAreaElement).value).toBe('Draft prompt');
    wrapper.unmount();
  });

  it('does not claim saved references are missing when the capability catalogs fail to read', async() => {
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) =>
      name === 'library-list-skills' || name === 'tools-list-by-category'
        ? Promise.reject(new Error('Catalog unavailable'))
        : original(name, ...args),
    );
    const wrapper = mount(StudioAgentsPage, {
      global: {
        stubs: {
          StudioTopbar:      { template: '<div />' },
          AgentDirectoryTab: {
            props: ['agents'],
            emits: ['edit'],
            template:
              '<button @click="$emit(\'edit\', agents[0])">Edit reviewer</button>',
          },
        },
      },
    });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Edit reviewer')!.trigger('click');
    await wrapper.findAll('button').find((button) => button.text() === 'Capabilities')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Catalog unavailable');
    expect(wrapper.text()).toContain('saved references are preserved');
    expect(wrapper.text()).not.toContain('not listed (preserved)');
    wrapper.unmount();
  });
});
