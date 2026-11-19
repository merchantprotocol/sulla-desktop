// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import AgentCapabilitiesFields from '@pkg/components/studio/AgentCapabilitiesFields.vue';
import AgentModelControls from '@pkg/components/studio/AgentModelControls.vue';
import AgentRoutingFields from '@pkg/components/studio/AgentRoutingFields.vue';
import StudioAgentsPage from '@pkg/components/studio/StudioAgentsPage.vue';
import { validateAgentEditorCreateInput } from '@pkg/main/agentEditorContract';
import { AgentModelSelectorController } from '@pkg/pages/agent/AgentModelSelectorController';
import { DEFAULT_AGENT_EDITOR_ROUTING, nextAgentEditorTeam } from '@pkg/shared/agentEditor';

const f = vi.hoisted(() => ({
  invoke:    vi.fn(),
  createTab: vi.fn((url: string, options: Record<string, unknown>) => ({ id: 'tab-try', url, ...options })),
  agent:     null as any,
  routing:   null as any,
  listDown:  false,
  stamp:     0,
}));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: f.invoke, on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/composables/useDatabaseAvailableReload', () => ({ useDatabaseAvailableReload: () => {} }));
vi.mock('@pkg/composables/useBrowserTabs', () => ({ useBrowserTabs: () => ({ createTab: f.createTab }) }));

const T1 = '2026-11-18T18:00:00.123Z';
const providers = [
  { id: 'codex', name: 'OpenAI Codex', connected: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: [{ id: 'high' }, { id: 'max' }] }] },
  { id: 'claude-code', name: 'Claude Code', connected: true, models: [{ id: 'sonnet', label: 'Sonnet', efforts: [{ id: 'high' }] }] },
];
function baseAgent(patch: Record<string, unknown> = {}) {
  return {
    id:                 'agent-1',
    slug:               'reviewer',
    name:               'Reviewer',
    description:        'Reviews artifacts.',
    provider:           null,
    model:              null,
    modelSlot:          'secondary',
    modelChoice:        { mode: 'class', class: 'fast' },
    prompt:             'Review the artifact.',
    sourceKind:         'local',
    marketplaceVersion: null,
    status:             'production',
    enabled:            true,
    runLocation:        'container',
    whenToCall:         'w',
    whenNotToCall:      'n',
    send:               's',
    returns:            'r',
    costTier:           null,
    canCall:            [],
    isBuiltin:          false,
    frontDoor:          null,
    updatedAt:          T1,
    type:               'worker',
    allowedTools:       [],
    skillRefs:          [],
    routineRefs:        [],
    ...patch,
  };
}
const nextStamp = () => `2026-11-18T18:00:0${ ++f.stamp }.000Z`;

beforeEach(() => {
  f.createTab.mockClear(); f.listDown = false; f.stamp = 0;
  f.agent = baseAgent();
  f.routing = { workers: [{ id: 'agent-1', slug: 'reviewer' }], workerBindings: {}, providers: structuredClone(providers), agentsList: [], subconsciousList: [], classes: { frontier: [], standard: [], fast: [], coding: [], local: [] }, followProviderOrder: {}, neverUse: [] };
  f.invoke.mockReset();
  f.invoke.mockImplementation(async(name: string, ...args: any[]) => {
    await Promise.resolve();
    if (name === 'agent-definitions:list') {
      if (f.listDown) throw new Error('Database unavailable');
      return [structuredClone(f.agent)];
    }
    if (name === 'model-routing:get') return structuredClone(f.routing);
    if (name === 'agent-definitions:export') return { spec: { skills: [] } };
    if (name === 'agent-definitions:update') return { id: args[0], slug: f.agent.slug, enabled: args[1].enabled, updated_at: nextStamp() };
    if (name === 'model-routing:worker-set') {
      const change = args[0];
      if (change.candidates === null) delete f.routing.workerBindings[change.slug];
      else f.routing.workerBindings[change.slug] = { agentId: change.agentId, revision: change.expectedRevision + 1, editToken: `token-${ f.stamp }`, candidates: change.candidates };
      return structuredClone(f.routing);
    }
    return [];
  });
});
afterEach(() => { document.body.innerHTML = '' });

const stubs = {
  StudioTopbar:      { template: '<div><slot name="actions" /></div>' },
  AgentDirectoryTab: { props: ['agents'], emits: ['edit'], template: '<button @click="$emit(\'edit\', agents[0])">Edit agent</button>' },
};
async function openEditor() {
  const wrapper = mount(StudioAgentsPage, { attachTo: document.body, global: { stubs } });
  await flushPromises();
  await button(wrapper, 'Edit agent').trigger('click');
  await flushPromises();
  return wrapper;
}
function button(wrapper: any, text: string) { return wrapper.findAll('button').find((b: any) => b.text() === text)! }
function updates() { return f.invoke.mock.calls.filter(call => call[0] === 'agent-definitions:update') }

describe('Try opens a chat on the saved agent slug', () => {
  it('uses the created agent slug even when the post-save readback fails', async() => {
    f.invoke.mockImplementation(async(name: string, ...args: any[]) => {
      await Promise.resolve();
      if (name === 'agent-definitions:list') { if (f.listDown) throw new Error('Database unavailable'); return [] }
      if (name === 'model-routing:get') return structuredClone(f.routing);
      if (name === 'agent-definitions:create') { const input = validateAgentEditorCreateInput(args[0]); return { id: 'agent-new', slug: input.slug, enabled: input.enabled, updated_at: nextStamp() } }
      return [];
    });
    const wrapper = mount(StudioAgentsPage, { attachTo: document.body, global: { stubs } });
    await flushPromises();
    await button(wrapper, '＋ New agent').trigger('click');
    const fields = wrapper.findAll('.frow input');
    await fields[0].setValue('QA Try'); await fields[1].setValue('qa-try');
    f.listDown = true;
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('The agent list will refresh');
    const tryButton = button(wrapper, 'Try');
    expect(tryButton.attributes('disabled')).toBeUndefined();
    await tryButton.trigger('click');
    expect(f.createTab).toHaveBeenCalledWith('about:blank', { mode: 'chat', title: 'QA Try · Chat', initialAgentId: 'qa-try' });
    wrapper.unmount();
  });

  it('a slug-selected chat resolves to the agent in the persona picker; a definition id does not', () => {
    const selector = new AgentModelSelectorController({ systemReady: ref(true), loading: ref(false), isRunning: ref(false), modelName: ref(''), modelMode: ref('remote') });
    selector.agentOptions.value = [{ id: 'agent-1', slug: 'reviewer', name: 'Reviewer', description: '', provider: null, model: null, modelSlot: null, status: 'production', enabled: true } as any];
    selector.restoreForChat(null, '', 'reviewer');
    expect(selector.activeModelLabel.value).toBe('Reviewer');
    selector.restoreForChat(null, '', 'agent-1');
    expect(selector.activeModelLabel.value).not.toBe('Reviewer');
  });
});

describe('saved timestamp and baseline after a profile save', () => {
  it('second save after a failed readback uses the first save timestamp, and an unedited saved form can be tried', async() => {
    const wrapper = await openEditor();
    await wrapper.findAll('.frow input')[0].setValue('First edit');
    f.listDown = true;
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(updates()[0][2].expectedUpdatedAt).toBe(T1);
    expect(wrapper.text()).toContain('The agent list will refresh');
    expect(button(wrapper, 'Try').attributes('disabled')).toBeUndefined();
    await wrapper.findAll('.frow input')[0].setValue('Second edit');
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(updates()[1][2]).toMatchObject({ name: 'Second edit', expectedUpdatedAt: '2026-11-18T18:00:01.000Z' });
    expect(wrapper.text()).not.toContain('changed elsewhere');
    wrapper.unmount();
  });

  it('keeps a draft typed during the save unsaved, then saves it against the new timestamp', async() => {
    const original = f.invoke.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve });
    f.invoke.mockImplementation(async(name: string, ...args: any[]) => {
      if (name === 'agent-definitions:update' && updates().length === 1) await held;
      return original(name, ...args);
    });
    const wrapper = await openEditor();
    await wrapper.findAll('.frow input')[0].setValue('Submitted');
    await button(wrapper, 'Save').trigger('click');
    await wrapper.findAll('.frow input')[0].setValue('Newer while saving');
    release(); await flushPromises();
    expect((wrapper.findAll('.frow input')[0].element as HTMLInputElement).value).toBe('Newer while saving');
    expect(button(wrapper, 'Try').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Save or discard edits before trying it.');
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(updates()[1][2]).toMatchObject({ name: 'Newer while saving', expectedUpdatedAt: '2026-11-18T18:00:01.000Z' });
    wrapper.unmount();
  });

  it('a model-clear failure after the profile write stays unsaved and keeps Try disabled', async() => {
    f.routing.workerBindings.reviewer = { agentId: 'agent-1', revision: 2, editToken: 'opened', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }] };
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name: string, ...args: any[]) => name === 'model-routing:worker-set' ? Promise.reject(new Error('Mapping store unavailable')) : original(name, ...args));
    const wrapper = await openEditor();
    await wrapper.find('[role="switch"]').trigger('click');
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(updates()).toHaveLength(1);
    expect(wrapper.text()).toContain('Profile was saved; model settings could not be saved. Mapping store unavailable');
    expect(button(wrapper, 'Try').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});

describe('disabled agent model settings', () => {
  it('saves the owner model chain before enabling in the same save, without an unavailable error', async() => {
    f.agent = baseAgent({ enabled: false });
    f.routing.workers = []; // the runnable workers list excludes disabled definitions
    const wrapper = await openEditor();
    await wrapper.find('[role="switch"]').trigger('click');
    await wrapper.find('[aria-label="Reasoning effort"]').setValue('high');
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    const names = f.invoke.mock.calls.map(call => call[0]);
    expect(names.indexOf('model-routing:worker-set')).toBeGreaterThan(-1);
    expect(names.indexOf('model-routing:worker-set')).toBeLessThan(names.indexOf('agent-definitions:update'));
    expect(f.invoke.mock.calls.find(call => call[0] === 'model-routing:worker-set')![1]).toMatchObject({ slug: 'reviewer', agentId: 'agent-1', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'high' }] });
    expect(updates()[0][2]).toMatchObject({ enabled: true });
    expect(updates()[0][2]).not.toHaveProperty('modelChoice');
    expect(wrapper.text()).toContain('Saved. Model changes apply to new work');
    wrapper.unmount();
  });
});

describe('team selection keeps every saved member', () => {
  const agents = [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }];
  function mountTeam(canCall: string[]) {
    const value = ref({ ...DEFAULT_AGENT_EDITOR_ROUTING, canCall });
    const Host = defineComponent({ setup: () => () => h(AgentRoutingFields, { modelValue: value.value, agents, 'onUpdate:modelValue': (next: any) => { value.value = next } }) });
    const wrapper = mount(Host, { attachTo: document.body });
    const select = () => wrapper.find('select[multiple]').element as HTMLSelectElement;
    const selected = () => Array.from(select().options).filter(option => option.selected).map(option => option.value);
    const choose = async(values: string[]) => {
      for (const option of Array.from(select().options)) option.selected = values.includes(option.value);
      select().dispatchEvent(new Event('change')); await flushPromises();
    };
    return { value, wrapper, selected, choose };
  }

  it('shows every saved member including unlisted ones, and adding one keeps the others in saved order', async() => {
    const team = mountTeam(['beta', 'missing-x', 'alpha']);
    expect(team.selected().sort()).toEqual(['alpha', 'beta', 'missing-x']);
    await team.choose(['alpha', 'beta', 'missing-x']);
    expect(team.value.value.canCall).toEqual(['beta', 'missing-x', 'alpha']);
    team.wrapper.unmount();
    const growing = mountTeam(['alpha']);
    await growing.choose(['alpha', 'beta']);
    expect(growing.value.value.canCall).toEqual(['alpha', 'beta']);
    expect(growing.selected()).toEqual(['alpha', 'beta']);
    growing.wrapper.unmount();
  });

  it('moves between default, wildcard and members without trapping or losing members', async() => {
    const team = mountTeam([]);
    expect(team.selected()).toEqual(['__default__']);
    await team.choose(['__default__', 'alpha']);
    expect(team.value.value.canCall).toEqual(['alpha']);
    expect(team.selected()).toEqual(['alpha']);
    await team.choose(['*', 'alpha']);
    expect(team.value.value.canCall).toEqual(['*']);
    expect(team.selected()).toEqual(['*']);
    await team.choose(['*', 'beta']);
    expect(team.value.value.canCall).toEqual(['beta']);
    await team.choose(['__default__', 'beta']);
    expect(team.value.value.canCall).toEqual([]);
    expect(team.selected()).toEqual(['__default__']);
    team.wrapper.unmount();
  });

  it('pure transition rules', () => {
    expect(nextAgentEditorTeam(['a', 'b'], ['b'])).toEqual(['b']);
    expect(nextAgentEditorTeam(['a'], [])).toEqual([]);
    expect(nextAgentEditorTeam(['*'], [])).toEqual([]);
  });
});

describe('routine references keep raw typing', () => {
  it('keeps a typed newline so another reference can be entered, and resyncs on an outside change', async() => {
    const refs = ref<string[]>(['routine.a']);
    const Host = defineComponent({ setup: () => () => h(AgentCapabilitiesFields, { allowedTools: [], skillRefs: [], routineRefs: refs.value, 'onUpdate:routineRefs': (next: string[]) => { refs.value = next } }) });
    const wrapper = mount(Host, { attachTo: document.body });
    await flushPromises();
    const area = () => wrapper.find('textarea');
    await area().setValue('routine.a\n'); await flushPromises();
    expect((area().element as HTMLTextAreaElement).value).toBe('routine.a\n');
    expect(refs.value).toEqual(['routine.a']);
    await area().setValue('routine.a\nroutine.b'); await flushPromises();
    expect(refs.value).toEqual(['routine.a', 'routine.b']);
    refs.value = ['routine.c']; await flushPromises();
    expect((area().element as HTMLTextAreaElement).value).toBe('routine.c');
    wrapper.unmount();
  });
});

describe('unpinning clears hidden fallbacks', () => {
  it('the controls emit an empty fallback list when the pin is turned off', async() => {
    const wrapper = mount(AgentModelControls, { props: { modelValue: { mode: 'pin', provider: 'codex', model: 'gpt-6-luna' }, baseChoice: { mode: 'list' }, fallbacks: [{ provider: 'claude-code', model: 'sonnet' }], state: { providers } as any } });
    await wrapper.find('[role="switch"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([{ mode: 'list' }]);
    expect(wrapper.emitted('update:fallbacks')?.at(-1)).toEqual([[]]);
    wrapper.unmount();
  });

  it('a new agent pinned, given a fallback, then unpinned saves on its first save', async() => {
    f.invoke.mockImplementation(async(name: string, ...args: any[]) => {
      await Promise.resolve();
      if (name === 'agent-definitions:list') return [];
      if (name === 'model-routing:get') return structuredClone(f.routing);
      if (name === 'agent-definitions:create') { const input = validateAgentEditorCreateInput(args[0]); return { id: 'agent-new', slug: input.slug, enabled: true, updated_at: nextStamp() } }
      return [];
    });
    const wrapper = mount(StudioAgentsPage, { attachTo: document.body, global: { stubs } });
    await flushPromises();
    await button(wrapper, '＋ New agent').trigger('click');
    const fields = wrapper.findAll('.frow input');
    await fields[0].setValue('Unpinned'); await fields[1].setValue('unpinned');
    await wrapper.find('[role="switch"]').trigger('click');
    await button(wrapper, 'Add fallback').trigger('click');
    await wrapper.find('[aria-label="Fallback provider 1"]').setValue('claude-code');
    await wrapper.find('[role="switch"]').trigger('click');
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    const create = f.invoke.mock.calls.find(call => call[0] === 'agent-definitions:create')!;
    expect(create[1]).toMatchObject({ modelChoice: { mode: 'list' }, modelFallbacks: [] });
    expect(wrapper.text()).not.toContain('require a pinned model choice');
    expect(wrapper.text()).toContain('Saved.');
    wrapper.unmount();
  });
});

describe('model class pin restores the latest unpinned class', () => {
  it('pin on and pin off keep the class chosen in this session, and save writes that class', async() => {
    const wrapper = await openEditor();
    const select = () => wrapper.find('[aria-label="Model class"]').element as HTMLSelectElement;
    expect(select().value).toBe('fast');
    await wrapper.find('[aria-label="Model class"]').setValue('coding');
    await wrapper.find('[role="switch"]').trigger('click');
    expect(select().disabled).toBe(true);
    expect(select().value).toBe('coding');
    await wrapper.find('[role="switch"]').trigger('click');
    expect(select().disabled).toBe(false);
    expect(select().value).toBe('coding');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(updates()[0][2].modelChoice).toEqual({ mode: 'class', class: 'coding' });
    expect(f.invoke.mock.calls.some(call => call[0] === 'model-routing:worker-set')).toBe(false);
    wrapper.unmount();
  });
});

describe('saved fallback effort stays visible when the catalog omits it', () => {
  it('shows and keeps an unlisted fallback effort, and choosing another model clears it', async() => {
    f.routing.providers = [{
      id: 'codex', name: 'OpenAI Codex', connected: true, models: [
        { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: [{ id: 'high' }] },
        { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [{ id: 'high' }] },
      ],
    }];
    f.routing.workerBindings = {
      reviewer: {
        agentId: 'agent-1', revision: 3, editToken: 'tok', candidates: [
          { provider: 'codex', model: 'gpt-6-luna', effort: 'high' },
          { provider: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
        ],
      },
    };
    const wrapper = await openEditor();
    const effort = () => wrapper.find('[aria-label="Fallback effort 1"]');
    expect((effort().element as HTMLSelectElement).value).toBe('max');
    expect(effort().text()).toContain('max · not listed');
    await wrapper.findAll('.frow input')[0].setValue('Reviewer renamed');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(f.invoke.mock.calls.some(call => call[0] === 'model-routing:worker-set')).toBe(false);
    expect((effort().element as HTMLSelectElement).value).toBe('max');
    expect(effort().text()).toContain('max · not listed');
    await wrapper.find('[aria-label="Fallback model 1"]').setValue('gpt-6-luna');
    expect(effort().text()).not.toContain('not listed');
    expect((effort().element as HTMLSelectElement).value).toBe('');
    wrapper.unmount();
  });
});

describe('owner binding recovery after a create whose list readback failed', () => {
  const luna = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
  const sol = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
  const grok = { provider: 'grok', model: 'grok-4.7' };
  const a = vi.hoisted(() => ({ routingDown: false, updateFails: false, definition: null as any }));
  const calls = (name: string) => f.invoke.mock.calls.filter(call => call[0] === name);
  const binding = () => f.routing.workerBindings['qa-created'];

  beforeEach(() => {
    a.routingDown = false; a.updateFails = false; a.definition = null;
    f.routing.workers = []; f.routing.workerBindings = {};
    f.routing.providers = [
      { id: 'codex', name: 'OpenAI Codex', connected: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: [{ id: 'high' }, { id: 'max' }] }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [{ id: 'high' }, { id: 'max' }] }] },
      { id: 'grok', name: 'Grok', connected: true, models: [{ id: 'grok-4.7', label: 'Grok 4.7', efforts: [] }] },
    ];
    f.invoke.mockImplementation(async(name: string, ...args: any[]) => {
      await Promise.resolve();
      if (name === 'agent-definitions:list') {
        if (f.listDown) throw new Error('Database unavailable');
        return a.definition ? [structuredClone(a.definition)] : [];
      }
      if (name === 'model-routing:get') {
        if (a.routingDown) throw new Error('Settings unavailable');
        return structuredClone(f.routing);
      }
      if (name === 'agent-definitions:create') {
        const input = validateAgentEditorCreateInput(args[0]);
        a.definition = baseAgent({ id: 'qa-created-id', slug: input.slug, name: input.name, modelChoice: input.modelChoice, updatedAt: nextStamp() });
        if (input.modelChoice?.mode === 'pin') {
          const { provider, model, effort } = input.modelChoice;
          f.routing.workerBindings[input.slug] = { agentId: 'qa-created-id', revision: 1, editToken: 'created-token', candidates: [{ provider, model, ...(effort ? { effort } : {}) }, ...input.modelFallbacks] };
          f.routing.workers.push({ id: 'qa-created-id', slug: input.slug });
        }
        return { id: 'qa-created-id', slug: input.slug, enabled: true, updated_at: a.definition.updatedAt };
      }
      if (name === 'agent-definitions:update') {
        if (a.updateFails) { a.updateFails = false; throw new Error('Profile store unavailable') }
        const patch = args[1];
        if (patch.expectedUpdatedAt !== a.definition.updatedAt) return null;
        a.definition = { ...a.definition, ...(patch.modelChoice ? { modelChoice: patch.modelChoice } : {}), name: patch.name, updatedAt: nextStamp() };
        return { id: a.definition.id, slug: a.definition.slug, enabled: true, updated_at: a.definition.updatedAt };
      }
      if (name === 'model-routing:worker-set') {
        const change = args[0]; const current = f.routing.workerBindings[change.slug];
        if (!current || current.agentId !== change.agentId || current.revision !== change.expectedRevision || current.editToken !== change.expectedToken) throw new Error('This mapping changed elsewhere. Reload before saving.');
        f.routing.workerBindings[change.slug] = { ...current, revision: current.revision + 1, editToken: `token-${ current.revision + 1 }`, candidates: change.candidates };
        return structuredClone(f.routing);
      }
      return [];
    });
  });

  async function createPinnedWhileListFails() {
    const wrapper = mount(StudioAgentsPage, { attachTo: document.body, global: { stubs } });
    await flushPromises();
    await button(wrapper, '＋ New agent').trigger('click');
    const fields = wrapper.findAll('.frow input');
    await fields[0].setValue('QA created reviewer'); await fields[1].setValue('qa-created');
    await wrapper.find('[role="switch"]').trigger('click');
    await wrapper.find('[aria-label="Pinned model"]').setValue('gpt-6-luna');
    await wrapper.find('[aria-label="Reasoning effort"]').setValue('max');
    await button(wrapper, 'Add fallback').trigger('click');
    await wrapper.find('[aria-label="Fallback provider 1"]').setValue('grok');
    f.listDown = true;
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(calls('agent-definitions:create')).toHaveLength(1);
    expect(binding()).toMatchObject({ revision: 1, candidates: [luna, grok] });
    return wrapper;
  }
  async function editToSol(wrapper: any) {
    await wrapper.find('[aria-label="Pinned model"]').setValue('gpt-6.1-sol');
    await wrapper.find('[aria-label="Reasoning effort"]').setValue('high');
  }

  it('saves a later model, effort and fallback edit through the owner binding with the created revision', async() => {
    const wrapper = await createPinnedWhileListFails();
    await editToSol(wrapper);
    await button(wrapper, 'Add fallback').trigger('click');
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(calls('model-routing:worker-set')).toHaveLength(1);
    expect(calls('model-routing:worker-set')[0][1]).toMatchObject({ slug: 'qa-created', agentId: 'qa-created-id', expectedRevision: 1, expectedToken: 'created-token' });
    expect(binding()).toMatchObject({ revision: 2, candidates: [sol, grok, { provider: 'codex', model: 'gpt-6-luna' }] });
    expect(calls('agent-definitions:update')[0][2]).not.toHaveProperty('modelChoice');
    expect(calls('agent-definitions:create')).toHaveLength(1);
    expect(wrapper.text()).toContain('Saved. Model changes apply to new work');
    expect(button(wrapper, 'Try').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('refuses a model save while model settings are unreadable, keeps the draft, and saves it once they recover', async() => {
    const wrapper = await createPinnedWhileListFails();
    a.routingDown = true;
    await editToSol(wrapper);
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('could not be loaded, so nothing was saved');
    expect(wrapper.text()).not.toContain('Saved.');
    expect(calls('model-routing:worker-set')).toHaveLength(0);
    expect(calls('agent-definitions:update')).toHaveLength(0);
    expect(a.definition.modelChoice).toEqual({ mode: 'pin', ...luna });
    expect(binding()).toMatchObject({ revision: 1, candidates: [luna, grok] });
    expect((wrapper.find('[aria-label="Pinned model"]').element as HTMLSelectElement).value).toBe('gpt-6.1-sol');
    expect(button(wrapper, 'Try').attributes('disabled')).toBeDefined();
    a.routingDown = false;
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(calls('model-routing:worker-set')).toHaveLength(1);
    expect(binding()).toMatchObject({ revision: 2, candidates: [sol, grok] });
    expect(wrapper.text()).toContain('Saved. Model changes apply to new work');
    expect(calls('agent-definitions:create')).toHaveLength(1);
    wrapper.unmount();
  });

  it('still saves a profile-only edit while model settings are unreadable, without touching the model', async() => {
    const wrapper = await createPinnedWhileListFails();
    a.routingDown = true;
    await wrapper.findAll('.frow input')[0].setValue('Renamed reviewer');
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(calls('model-routing:worker-set')).toHaveLength(0);
    expect(calls('agent-definitions:update')[0][2]).toMatchObject({ name: 'Renamed reviewer' });
    expect(calls('agent-definitions:update')[0][2]).not.toHaveProperty('modelChoice');
    expect(binding()).toMatchObject({ revision: 1, candidates: [luna, grok] });
    expect(wrapper.text()).toContain('Saved.');
    wrapper.unmount();
  });

  it('refuses rather than adopting a chain that changed elsewhere after the create', async() => {
    const wrapper = await createPinnedWhileListFails();
    const foreign = { agentId: 'qa-created-id', revision: 2, editToken: 'someone-else', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'high' }] };
    f.routing.workerBindings['qa-created'] = structuredClone(foreign);
    await editToSol(wrapper);
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('model settings changed elsewhere, so nothing was saved');
    expect(calls('model-routing:worker-set')).toHaveLength(0);
    expect(calls('agent-definitions:update')).toHaveLength(0);
    expect(binding()).toEqual(foreign);
    wrapper.unmount();
  });

  it('reports a profile failure after the recovered model write honestly and finishes on retry without rewriting the model', async() => {
    const wrapper = await createPinnedWhileListFails();
    await editToSol(wrapper);
    await wrapper.findAll('.frow input')[0].setValue('Renamed reviewer');
    a.updateFails = true;
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('Model settings were saved; profile could not be saved. Profile store unavailable');
    expect(binding()).toMatchObject({ revision: 2, candidates: [sol, grok] });
    expect(button(wrapper, 'Try').attributes('disabled')).toBeDefined();
    await button(wrapper, 'Save').trigger('click'); await flushPromises();
    expect(calls('model-routing:worker-set')).toHaveLength(1);
    expect(a.definition.name).toBe('Renamed reviewer');
    expect(wrapper.text()).toContain('Saved.');
    wrapper.unmount();
  });

  it('writes the click-time primary and fallbacks after routing recovery, then saves the draft typed during that save', async() => {
    f.routing.providers.push({ id: 'claude-code', name: 'Claude Code', connected: true, models: [{ id: 'sonnet', label: 'Sonnet', efforts: [{ id: 'high' }] }] });
    const wrapper = await createPinnedWhileListFails();
    await editToSol(wrapper);
    await wrapper.find('[aria-label="Fallback provider 1"]').setValue('claude-code');
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async(name: string, ...args: any[]) => {
      if (name === 'model-routing:get' && !held) { held = true; await gate; }
      return original(name, ...args);
    });
    await button(wrapper, 'Save').trigger('click');
    expect(held).toBe(true);
    await wrapper.find('[aria-label="Pinned model"]').setValue('gpt-6-luna');
    await wrapper.find('[aria-label="Fallback effort 1"]').setValue('high');
    release();
    await flushPromises();
    const sets = calls('model-routing:worker-set');
    expect(sets).toHaveLength(1);
    expect(sets[0][1].candidates).toEqual([
      { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      { provider: 'claude-code', model: 'sonnet' },
    ]);
    expect((wrapper.find('[aria-label="Pinned model"]').element as HTMLSelectElement).value).toBe('gpt-6-luna');
    expect((wrapper.find('[aria-label="Fallback effort 1"]').element as HTMLSelectElement).value).toBe('high');
    expect(button(wrapper, 'Try').attributes('disabled')).toBeDefined();
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(calls('model-routing:worker-set')[1][1]).toMatchObject({
      expectedRevision: 2,
      candidates: [
        { provider: 'codex', model: 'gpt-6-luna' },
        { provider: 'claude-code', model: 'sonnet', effort: 'high' },
      ],
    });
    wrapper.unmount();
  });
});
