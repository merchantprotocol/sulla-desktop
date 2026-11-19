// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import ModelsSection from '@pkg/components/settings/sections/ModelsSection.vue';
import StudioAgentsPage from '@pkg/components/studio/StudioAgentsPage.vue';
const f = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    invoke:        vi.fn(),
    on:            vi.fn((channel: string, listener: (...args: any[]) => void) => {
      const entries = listeners.get(channel) ?? new Set(); entries.add(listener); listeners.set(channel, entries);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      listeners.get(channel)?.delete(listener);
    }),
    listeners,
    state:          null as any,
    agent:          null as any,
  };
});
vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    invoke:         f.invoke,
    on:             f.on,
    send:           vi.fn(),
    removeListener: f.removeListener,
  },
}));
vi.mock('@pkg/composables/useDatabaseAvailableReload', () => ({ useDatabaseAvailableReload: () => {} }));
const mounted:any[] = [];
beforeEach(() => {
  f.listeners.clear(); f.on.mockClear(); f.removeListener.mockClear();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  f.agent = { id: 'luna-id', slug: 'codex-luna-worker', name: 'Codex LUNA Worker', description: 'Existing worker', provider: 'codex', modelSlot: 'secondary', modelChoice: { mode: 'class', class: 'fast' }, prompt: 'Original workflow instructions', sourceKind: 'builtin' };
  f.state = { workers: [{ id: 'luna-id', slug: 'codex-luna-worker' }], agentsList: [], classes: { fast: [], standard: [], frontier: [], coding: [], local: [] }, followProviderOrder: { fast: false }, neverUse: [], providers: [{ id: 'codex', name: 'OpenAI Codex', connected: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: [{ id: 'high' }, { id: 'max' }] }] }, { id: 'claude-code', name: 'Claude Code', connected: true, models: [{ id: 'sonnet', label: 'Sonnet', efforts: [{ id: 'high' }] }] }], workerBindings: { 'codex-luna-worker': { agentId: 'luna-id', revision: 4, editToken: 'old-token', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, { provider: 'claude-code', model: 'sonnet', effort: 'high' }] } } };
  f.invoke.mockReset(); f.invoke.mockImplementation(async(name:string, ...args:any[]) => {
    await Promise.resolve();
    if (name === 'model-routing:get') return structuredClone(f.state);
    if (name === 'agent-definitions:list') return [structuredClone(f.agent)];
    if (name === 'agent-definitions:export') return { spec: { skills: [] } };
    if (name === 'model-routing:worker-set') { const change = args[0]; if (change.candidates === null) delete f.state.workerBindings[change.slug]; else f.state.workerBindings[change.slug] = { ...f.state.workerBindings[change.slug], candidates: change.candidates, revision: 5, editToken: 'new-token' }; return structuredClone(f.state) }
    if (name === 'agent-definitions:update') return {};
    return [];
  });
});
afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers();
});
async function open() { const wrapper = mount(StudioAgentsPage, { attachTo: document.body, global: { stubs: { StudioTopbar: { template: '<div />' }, AgentDirectoryTab: { props: ['agents'], emits: ['edit'], template: '<button @click="$emit(\'edit\',agents[0])">Edit Luna</button>' } } } }); mounted.push(wrapper); await flushPromises(); await wrapper.findAll('button').find(button => button.text() === 'Edit Luna')!.trigger('click'); return wrapper }
function emitRoutingStatus(providers = f.state.providers) { for (const listener of f.listeners.get('model-routing:status') ?? []) listener({}, structuredClone(providers)); }
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>(resolve => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}
it('edits effort on the existing agent page with one Save and preserves configured fallbacks', async() => {
  const wrapper = await open(); expect((wrapper.find('[aria-label="Pinned model"]').element as HTMLSelectElement).value).toBe('gpt-6-luna'); expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('max');
  expect(wrapper.text()).toContain('Fallback models · 1'); expect(wrapper.findAll('button').filter(button => button.text() === 'Save')).toHaveLength(1);
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke).toHaveBeenCalledWith('model-routing:worker-set', expect.objectContaining({ expectedRevision: 4, expectedToken: 'old-token', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, { provider: 'claude-code', model: 'sonnet', effort: 'high' }] }));
  const update = f.invoke.mock.calls.find(call => call[0] === 'agent-definitions:update')!; expect(update[2].prompt).toBe('Original workflow instructions'); expect(update[2]).not.toHaveProperty('modelChoice'); expect(wrapper.text()).toContain('Saved. Model changes apply to new work');
});
it('uses the timestamp captured at save start when the model await changes the active readback', async() => {
  const originUpdatedAt = '2026-11-18T18:00:00.123Z';
  f.agent.updatedAt = originUpdatedAt;
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation((name, ...args) => {
    if (name === 'agent-definitions:list') return Promise.resolve([f.agent]);
    if (name === 'model-routing:worker-set') {
      f.agent.updatedAt = '2026-11-18T18:00:01.456Z';
      return original(name, ...args);
    }
    return original(name, ...args);
  });
  const wrapper = await open();
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high');
  await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click');
  await flushPromises();
  const update = f.invoke.mock.calls.find(call => call[0] === 'agent-definitions:update');
  expect(update?.[2].expectedUpdatedAt).toBe(originUpdatedAt);
});
it('keeps the edited effort visible when a stale owner-setting save is refused', async() => {
  const wrapper = await open(); const original = f.invoke.getMockImplementation()!; f.invoke.mockImplementation((name, ...args) => name === 'model-routing:worker-set' ? Promise.reject(new Error('This mapping changed elsewhere. Reload before saving.')) : original(name, ...args));
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('This mapping changed elsewhere'); expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('high'); expect(f.invoke.mock.calls.some(call => call[0] === 'agent-definitions:update')).toBe(false);
});
it('clears model-specific effort on version change and explicitly returns to the original class', async() => {
  f.state.providers[0].models.push({ id: 'gpt-new-version', label: 'New version', efforts: [{ id: 'high' }] });
  const wrapper = await open(); await wrapper.find('[aria-label="Pinned model"]').setValue('gpt-new-version');
  expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('');
  await wrapper.find('[role="switch"]').trigger('click'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke).toHaveBeenCalledWith('agent-definitions:update', 'luna-id', expect.objectContaining({ modelChoice: { mode: 'class', class: 'fast' } }));
  expect(f.invoke).toHaveBeenCalledWith('model-routing:worker-set', expect.objectContaining({ candidates: null, expectedRevision: 4, expectedToken: 'old-token' }));
});
it('reports partial profile failure honestly and does not lose the successful model edit or its new revision', async() => {
  const wrapper = await open(); const original = f.invoke.getMockImplementation()!; let fail = true;
  f.invoke.mockImplementation((name, ...args) => name === 'agent-definitions:update' && fail ? Promise.reject(new Error('Profile unavailable')) : original(name, ...args));
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('Model settings were saved; profile could not be saved'); fail = false;
  await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke.mock.calls.filter(call => call[0] === 'model-routing:worker-set')).toHaveLength(1);
  expect(wrapper.text()).toContain('Saved. Model changes apply');
});
it('reports configured model and effort in the existing Manage list', async() => {
  const wrapper = mount(StudioAgentsPage, { global: { stubs: { StudioTopbar: { template: '<div />' }, AgentDirectoryTab: { template: '<div />' } } } }); mounted.push(wrapper); await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === 'Manage')!.trigger('click');
  expect(wrapper.find('tbody').text()).toContain('gpt-6-luna · max'); expect(wrapper.find('tbody').text()).not.toContain('Class: Fast');
});

it('recovers provider models on a periodic refresh when the agent catalog is unchanged', async() => {
  vi.useFakeTimers();
  f.state.providers[0] = { ...f.state.providers[0], connected: false, models: [] };
  const wrapper = await open();
  expect(wrapper.find('[aria-label="Pinned model"]').text()).toContain('gpt-6-luna');
  const reads = f.invoke.mock.calls.filter(call => call[0] === 'model-routing:get').length;
  f.state.providers[0] = { ...f.state.providers[0], connected: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna recovered', efforts: [{ id: 'high' }, { id: 'max' }] }] };
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.invoke.mock.calls.filter(call => call[0] === 'model-routing:get').length).toBeGreaterThan(reads);
  expect(wrapper.find('[aria-label="Pinned model"]').text()).toContain('GPT-6-Luna recovered');
});

it('keeps a newer provider status push when the initial routing read resolves out of order', async() => {
  const stale = structuredClone(f.state); stale.providers[0] = { ...stale.providers[0], connected: false, models: [] };
  const read = deferred<any>(); const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation((name, ...args) => name === 'model-routing:get' ? read.promise : original(name, ...args));
  const wrapper = mount(StudioAgentsPage, { global: { stubs: { StudioTopbar: { template: '<div />' }, AgentDirectoryTab: { props: ['agents'], emits: ['edit'], template: '<button @click="$emit(\'edit\',agents[0])">Edit Luna</button>' } } } }); mounted.push(wrapper);
  await flushPromises();
  const recovered = structuredClone(f.state.providers); recovered[0] = { ...recovered[0], connected: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna from push', efforts: [{ id: 'high' }, { id: 'max' }] }] };
  emitRoutingStatus(recovered); read.resolve(stale); await flushPromises(); await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === 'Edit Luna')!.trigger('click');
  expect(wrapper.find('[aria-label="Pinned model"]').text()).toContain('GPT-6-Luna from push');
});

it('keeps unsaved profile, selection and fallback drafts when provider status changes', async() => {
  const wrapper = await open();
  const fields = wrapper.findAll('.frow input'); await fields[0].setValue('Draft worker'); await wrapper.find('.field textarea').setValue('Draft description');
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high'); await wrapper.find('[aria-label="Fallback effort 1"]').setValue('');
  emitRoutingStatus(f.state.providers); await flushPromises();
  expect((fields[0].element as HTMLInputElement).value).toBe('Draft worker'); expect((wrapper.find('.field textarea').element as HTMLTextAreaElement).value).toBe('Draft description');
  expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('high'); expect((wrapper.find('[aria-label="Fallback effort 1"]').element as HTMLSelectElement).value).toBe('');
});

it('shows the saved model once model settings load after the editor opened without them, keeping profile drafts', async() => {
  vi.useFakeTimers();
  const original = f.invoke.getMockImplementation()!; let routingDown = true;
  f.invoke.mockImplementation((name, ...args) => name === 'model-routing:get' && routingDown ? Promise.reject(new Error('Database unavailable')) : original(name, ...args));
  const wrapper = await open(); expect(wrapper.text()).toContain('Model settings could not be loaded');
  await wrapper.findAll('.frow input')[0].setValue('Draft worker');
  routingDown = false; await vi.advanceTimersByTimeAsync(5_000);
  expect((wrapper.find('[aria-label="Pinned model"]').element as HTMLSelectElement).value).toBe('gpt-6-luna'); expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('max');
  expect(wrapper.text()).toContain('Fallback models · 1'); expect((wrapper.findAll('.frow input')[0].element as HTMLInputElement).value).toBe('Draft worker');
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke).toHaveBeenCalledWith('model-routing:worker-set', expect.objectContaining({ expectedRevision: 4, expectedToken: 'old-token', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, { provider: 'claude-code', model: 'sonnet', effort: 'high' }] }));
  expect(f.invoke.mock.calls.find(call => call[0] === 'agent-definitions:update')![2].name).toBe('Draft worker');
});

it('keeps the model draft and opened revision when a background refresh sees an external mapping change', async() => {
  vi.useFakeTimers();
  const wrapper = await open();
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high'); await wrapper.find('[aria-label="Fallback effort 1"]').setValue('');
  f.state.workerBindings['codex-luna-worker'] = { agentId: 'luna-id', revision: 9, editToken: 'external-token', candidates: [{ provider: 'claude-code', model: 'sonnet' }] };
  const reads = f.invoke.mock.calls.filter(call => call[0] === 'model-routing:get').length;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.invoke.mock.calls.filter(call => call[0] === 'model-routing:get').length).toBeGreaterThan(reads);
  expect((wrapper.find('[aria-label="Pinned provider"]').element as HTMLSelectElement).value).toBe('codex'); expect((wrapper.find('[aria-label="Pinned model"]').element as HTMLSelectElement).value).toBe('gpt-6-luna');
  expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('high'); expect((wrapper.find('[aria-label="Fallback effort 1"]').element as HTMLSelectElement).value).toBe('');
  expect(f.invoke.mock.calls.some(call => call[0] === 'model-routing:worker-set')).toBe(false);
  await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke).toHaveBeenCalledWith('model-routing:worker-set', expect.objectContaining({ expectedRevision: 4, expectedToken: 'old-token' }));
});

it('adopts the current server mapping from an intentional save readback', async() => {
  const wrapper = await open();
  f.state.workerBindings['codex-luna-worker'] = { ...f.state.workerBindings['codex-luna-worker'], revision: 9, editToken: 'current-token' };
  await wrapper.findAll('.frow input')[0].setValue('Renamed worker'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke.mock.calls.some(call => call[0] === 'model-routing:worker-set')).toBe(false); expect(wrapper.text()).toContain('Saved.');
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke).toHaveBeenCalledWith('model-routing:worker-set', expect.objectContaining({ expectedRevision: 9, expectedToken: 'current-token' }));
});

it('does not let a refresh that started before Save replace the saved revision or edited model', async() => {
  vi.useFakeTimers();
  const wrapper = await open(); const stale = structuredClone(f.state); const held = deferred<any>(); const original = f.invoke.getMockImplementation()!; let hold = true;
  f.invoke.mockImplementation((name, ...args) => {
    if (name === 'model-routing:get' && hold) {
      hold = false;

      return held.promise;
    }
    return original(name, ...args);
  });
  await vi.advanceTimersByTimeAsync(5_000); expect(hold).toBe(false);
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('high'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke).toHaveBeenCalledWith('model-routing:worker-set', expect.objectContaining({ expectedRevision: 4, expectedToken: 'old-token' }));
  held.resolve(stale); await flushPromises();
  expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('high');
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('max'); await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(f.invoke.mock.calls.filter(call => call[0] === 'model-routing:worker-set').at(-1)![1]).toEqual(expect.objectContaining({ expectedRevision: 5, expectedToken: 'new-token' }));
});

it('cleans the provider listener and periodic refresh on unmount', async() => {
  vi.useFakeTimers();
  const wrapper = await open(); const reads = f.invoke.mock.calls.filter(call => call[0] === 'model-routing:get').length;
  expect(f.listeners.get('model-routing:status')?.size).toBe(1); wrapper.unmount(); await vi.advanceTimersByTimeAsync(10_000);
  expect(f.listeners.get('model-routing:status')?.size ?? 0).toBe(0); expect(f.removeListener).toHaveBeenCalledWith('model-routing:status', expect.any(Function));
  expect(f.invoke.mock.calls.filter(call => call[0] === 'model-routing:get').length).toBe(reads);
});

it('keeps shared routing in AI Models without the redundant worker configuration section', async() => {
  const wrapper = mount(ModelsSection, { global: { stubs: { DefaultsCard: { template: '<div>Shared defaults</div>' }, RoleLedger: { template: '<div>Shared role models</div>' }, RoutingList: { template: '<div />' }, RouteTrace: { template: '<div />' }, PrefMore: { template: '<div />' } } } }); mounted.push(wrapper); await flushPromises();
  expect(wrapper.text()).toContain('Shared role models'); expect(wrapper.text()).not.toContain('Agent model mappings'); expect(wrapper.find('[aria-label="Agent model mappings"]').exists()).toBe(false);
});

it('creates a new agent with an exact pinned model and effort, then reloads its owner mapping', async() => {
  const original = f.invoke.getMockImplementation()!;
  let created: any;
  f.invoke.mockImplementation((name, ...args) => {
    if (name === 'agent-definitions:create') {
      // Electron rejects a Vue Proxy before dispatching its main-process handler.
      const payload = structuredClone(args[0]);
      created = { ...f.agent, id: 'qa-new-agent', slug: payload.slug, name: payload.name, prompt: payload.prompt, modelChoice: { mode: 'class', class: 'coding' }, sourceKind: 'local' };
      f.state.workers.push({ id: created.id, slug: created.slug });
      f.state.workerBindings[created.slug] = { agentId: created.id, revision: 1, editToken: 'initial', connections: { codex: 'subscription-id' }, candidates: [payload.modelChoice, ...payload.modelFallbacks] };
      return Promise.resolve(created);
    }
    if (name === 'agent-definitions:list' && created) return Promise.resolve([structuredClone(f.agent), created]);
    return original(name, ...args);
  });
  const wrapper = mount(StudioAgentsPage, { global: { stubs: { StudioTopbar: { template: '<div><slot name="actions" /></div>' }, AgentDirectoryTab: { template: '<div />' } } } }); mounted.push(wrapper); await flushPromises();
  await wrapper.findAll('button').find(button => button.text().includes('New agent'))!.trigger('click');
  const fields = wrapper.findAll('.frow input');
  await fields[0].setValue('Grok QA reviewer'); await fields[1].setValue('qa-grok-reviewer');
  await wrapper.find('[role="switch"]').trigger('click');
  await wrapper.find('[aria-label="Reasoning effort"]').setValue('max');
  await wrapper.findAll('button').find(button => button.text() === 'Add fallback')!.trigger('click');
  await wrapper.find('[aria-label="Fallback provider 1"]').setValue('claude-code');
  await wrapper.find('[aria-label="Fallback model 1"]').setValue('sonnet');
  await wrapper.find('[aria-label="Fallback effort 1"]').setValue('high');
  await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click'); await flushPromises();
  expect(created?.slug).toBe('qa-grok-reviewer');
  expect(f.invoke).toHaveBeenCalledWith('agent-definitions:create', expect.objectContaining({
    slug:           'qa-grok-reviewer',
    modelChoice:    { mode: 'pin', provider: 'codex', model: 'gpt-6-luna', effort: 'max' },
    modelFallbacks: [{ provider: 'claude-code', model: 'sonnet', effort: 'high' }],
  }));
  expect(f.invoke.mock.calls.some(call => call[0] === 'model-routing:worker-set')).toBe(false);
  expect((wrapper.find('[aria-label="Pinned model"]').element as HTMLSelectElement).value).toBe('gpt-6-luna');
  expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('max');
  expect(wrapper.text()).toContain('Fallback models · 1');
  expect(wrapper.text()).toContain('Saved. Model changes apply');
  expect(wrapper.text()).not.toContain('could not be cloned');
  expect(wrapper.text()).not.toContain('Save this agent first');
});
