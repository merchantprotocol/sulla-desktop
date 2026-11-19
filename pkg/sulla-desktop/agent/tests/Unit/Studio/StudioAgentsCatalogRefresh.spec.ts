// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The Agents page stays mounted in a hidden native tab, so an agent registered after it first
// loaded must still appear. The real page and model controls run; only the IPC boundary is faked
// (a read-only catalog that the test can grow, hold or fail) and interval timers are fake.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  agents: [] as any[],
  state: null as any,
  calls: [] as string[],
  holdList: undefined as undefined | { promise: Promise<unknown>; release: (value: unknown) => void },
  failList: false,
  holdExport: undefined as undefined | Promise<unknown>,
  realHandler: false,
  listArgs: [] as unknown[],
  creates: [] as any[],
  updates: [] as any[][],
  holdUpdate: undefined as undefined | Promise<unknown>,
  holdCreate: undefined as undefined | Promise<unknown>,
  holdWorkerSet: undefined as undefined | Promise<unknown>,
  workerSets: [] as any[],
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false, on: () => undefined, once: () => undefined }, ipcMain: { handle: () => undefined, on: () => undefined, removeHandler: () => undefined }, webContents: { getAllWebContents: () => [] }, safeStorage: {} }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: {
  invoke: async(name: string, ...args: any[]) => {
    f.calls.push(name);
    await Promise.resolve();
    if (name === 'model-routing:get') return structuredClone(f.state);
    if (name === 'agent-definitions:list') {
      f.listArgs.push(args[0]);
      // The production list function behind the IPC channel, with its real database read guard.
      if (f.realHandler) { const { listAgentDefinitions } = await import('@pkg/main/agentsIpc'); return listAgentDefinitions(args[0]) }
      if (f.failList) throw new Error('database unavailable');
      if (f.holdList) { const held = f.holdList; f.holdList = undefined; return held.promise }
      return structuredClone(f.agents);
    }
    if (name === 'agent-definitions:export') { if (f.holdExport) { const held = f.holdExport; f.holdExport = undefined; await held } return { spec: { skills: [] } } }
    if (name === 'agent-definitions:update') {
      f.updates.push(args);
      if (f.holdUpdate) { const held = f.holdUpdate; f.holdUpdate = undefined; await held }
      const agent = f.agents.find(row => row.id === args[0]); Object.assign(agent, args[1]); return { id: agent.id, slug: agent.slug, name: agent.name }
    }
    if (name === 'agent-definitions:create') {
      // The persisted row the create handler returns.
      f.creates.push(args[0]);
      if (f.holdCreate) { const held = f.holdCreate; f.holdCreate = undefined; await held }
      const created = { id: `created-${ f.creates.length }`, slug: args[0].slug, name: args[0].name, description: args[0].description ?? '', provider: null, modelSlot: args[0].modelSlot, prompt: args[0].prompt, sourceKind: 'local', updatedAt: '2026-11-17T11:00:00Z' };
      f.agents.push(created);
      return { id: created.id, slug: created.slug, name: created.name };
    }
    if (name === 'model-routing:worker-set') {
      f.workerSets.push(args[0]);
      if (f.holdWorkerSet) { const held = f.holdWorkerSet; f.holdWorkerSet = undefined; await held }
      return structuredClone(f.state);
    }
    return [];
  },
  on: vi.fn(), send: vi.fn(), removeListener: vi.fn(),
} }));
vi.mock('@pkg/composables/useDatabaseAvailableReload', () => ({ useDatabaseAvailableReload: () => {} }));

import StudioAgentsPage from '@pkg/components/studio/StudioAgentsPage.vue';

const MUTATIONS = ['agent-definitions:update', 'agent-definitions:create', 'agent-definitions:delete', 'model-routing:worker-set', 'agent-definitions:publish'];
const agent = (index: number, extra: Record<string, unknown> = {}) => ({ id: `agent-${ index }`, slug: `agent-${ index }`, name: `Agent ${ index }`, description: '', provider: 'codex', modelSlot: 'secondary', prompt: `Prompt ${ index }`, sourceKind: 'local', updatedAt: '2026-11-17T10:00:00Z', ...extra });
const QA = agent(17, { id: 'qa-id', slug: 'qa-chat-grok-20261117', name: 'QA chat Grok', provider: 'grok' });

let host: HTMLElement;
const mounted: VueWrapper[] = [];
async function openPage() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const wrapper = mount(StudioAgentsPage, { attachTo: host, global: { stubs: {
    StudioTopbar: { template: '<div><slot name="actions" /></div>' },
    AgentDirectoryTab: { props: ['agents'], emits: ['edit'], template: '<div><button v-for="a in agents" :key="a.id" class="dir-edit" @click="$emit(\'edit\', a)">{{ a.name }}</button></div>' },
  } } });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}
const installed = (wrapper: VueWrapper) => /(\d+) installed/.exec(wrapper.text())?.[1];
const tick = async(ms = 5_000) => { await vi.advanceTimersByTimeAsync(ms); await flushPromises() };
const count = (name: string) => f.calls.filter(call => call === name).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  f.agents = Array.from({ length: 15 }, (_, index) => agent(index + 1));
  f.agents.unshift({ ...agent(0), id: 'luna-id', slug: 'codex-luna-worker', name: 'Codex LUNA Worker', modelChoice: { mode: 'class', class: 'fast' } });
  f.state = { workers: [], agentsList: [], classes: { fast: [], standard: [], frontier: [], coding: [], local: [] }, followProviderOrder: { fast: false }, neverUse: [],
    providers: [{ id: 'codex', name: 'OpenAI Codex', connected: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: [{ id: 'high' }, { id: 'max' }] }] }],
    workerBindings: { 'codex-luna-worker': { agentId: 'luna-id', revision: 4, editToken: 'old-token', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }] } } };
  f.calls = []; f.holdList = undefined; f.failList = false; f.holdExport = undefined; f.realHandler = false; f.listArgs = []; f.creates = []; f.updates = []; f.holdUpdate = undefined; f.holdCreate = undefined; f.holdWorkerSet = undefined; f.workerSets = [];
});
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); host?.remove(); vi.useRealTimers() });

describe('Agents page catalog while it stays mounted', () => {
  it('shows an agent registered after the page first loaded, without remounting, and reads details only on change', async() => {
    const wrapper = await openPage();
    expect(installed(wrapper)).toBe('16');
    const exports = count('agent-definitions:export');
    await tick();
    expect(count('agent-definitions:export')).toBe(exports);

    f.agents.push(structuredClone(QA));
    await tick();
    expect(installed(wrapper)).toBe('17');
    expect(wrapper.text()).toContain('QA chat Grok');
    expect(count('agent-definitions:export')).toBe(exports + 17);
    await tick();
    expect(count('agent-definitions:export')).toBe(exports + 17);
    expect(f.calls.filter(call => MUTATIONS.includes(call))).toEqual([]);
  });

  it('pauses while its native tab is hidden and catches up within one interval when shown', async() => {
    const wrapper = await openPage();
    host.style.display = 'none';
    f.agents.push(structuredClone(QA));
    const reads = count('agent-definitions:list');
    await tick(20_000);
    expect(count('agent-definitions:list')).toBe(reads);
    expect(installed(wrapper)).toBe('16');

    host.style.display = '';
    await tick();
    expect(installed(wrapper)).toBe('17');
  });

  it('leaves an open editor and its unsaved choices untouched when the catalog changes', async() => {
    const wrapper = await openPage();
    await wrapper.findAll('button.dir-edit').find(button => button.text() === 'Codex LUNA Worker')!.trigger('click');
    await wrapper.find('input').setValue('Renamed, not saved');
    await wrapper.find('[aria-label="Reasoning effort"]').setValue('high');
    await wrapper.findAll('.tabs button').find(button => button.text() === 'Prompt')!.trigger('click');
    await wrapper.find('textarea').setValue('Unsaved prompt');

    f.agents.push(structuredClone(QA));
    await tick();
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('Unsaved prompt');
    await wrapper.findAll('.tabs button').find(button => button.text() === 'Profile')!.trigger('click');
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('Renamed, not saved');
    expect((wrapper.find('[aria-label="Reasoning effort"]').element as HTMLSelectElement).value).toBe('high');
    expect(f.calls.filter(call => MUTATIONS.includes(call))).toEqual([]);
  });

  it('never lets a slower periodic read overwrite the catalog loaded after a save', async() => {
    const wrapper = await openPage();
    let release!: (value: unknown) => void;
    f.holdList = { promise: new Promise(resolve => { release = resolve }), release: value => release(value) };
    const before = structuredClone(f.agents);
    await tick();

    await wrapper.findAll('button.dir-edit').find(button => button.text() === 'Agent 1')!.trigger('click');
    await wrapper.find('input').setValue('Agent 1 renamed');
    f.agents.push(structuredClone(QA));
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Saved.');

    release(before);
    await flushPromises();
    await wrapper.find('button.back').trigger('click');
    expect(installed(wrapper)).toBe('17');
    expect(wrapper.text()).toContain('Agent 1 renamed');
  });

  it('recovers the list when the first load failed', async() => {
    f.failList = true;
    const wrapper = await openPage();
    await wrapper.findAll('button').find(button => button.text() === 'Manage')!.trigger('click');
    expect(wrapper.text()).toContain('database unavailable');
    f.failList = false;
    await tick();
    expect(wrapper.text()).not.toContain('database unavailable');
    expect(installed(wrapper)).toBe('16');
  });

  it('stops reading after the page unmounts', async() => {
    const wrapper = await openPage();
    wrapper.unmount(); mounted.splice(mounted.indexOf(wrapper), 1);
    const reads = count('agent-definitions:list');
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(count('agent-definitions:list')).toBe(reads);
  });

  it('drops a periodic refresh whose details were still loading when a save reloaded the catalog', async() => {
    const wrapper = await openPage();
    await wrapper.findAll('button.dir-edit').find(button => button.text() === 'Agent 1')!.trigger('click');
    // The catalog changes; the periodic refresh then stalls while reading details.
    f.agents.push(structuredClone(QA));
    let release!: () => void;
    f.holdExport = new Promise<void>(resolve => { release = resolve });
    await tick();

    await wrapper.find('input').setValue('Agent 1 renamed');
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click');
    await flushPromises();
    release();
    await flushPromises();
    await wrapper.find('button.back').trigger('click');
    expect(wrapper.text()).toContain('Agent 1 renamed');
    expect(installed(wrapper)).toBe('17');
  });

  it('keeps the loaded catalog and says so when a periodic read fails', async() => {
    const wrapper = await openPage();
    f.failList = true;
    await tick();
    expect(installed(wrapper)).toBe('16');
    expect(wrapper.text()).toContain('Agent 1');
    expect(wrapper.find('[role="status"]').text()).toMatch(/last loaded list/);
    expect(f.calls.filter(call => MUTATIONS.includes(call))).toEqual([]);

    f.failList = false; f.agents.push(structuredClone(QA));
    await tick();
    expect(installed(wrapper)).toBe('17');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });
});

describe('Agents page catalog during a database outage (real list handler and read guard)', () => {
  const DB_PORT = 30116;
  const refused = () => Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${ DB_PORT }`), { code: 'ECONNREFUSED', port: DB_PORT, address: '127.0.0.1' });
  /** The stored row the response was mapped from. */
  const toRow = (a: any) => ({ id: a.id, slug: a.slug, name: a.name, description: a.description, provider: a.provider, model: a.model ?? null, model_slot: a.modelSlot, model_choice: a.modelChoice ?? null,
    prompt_content: a.prompt, source_kind: a.sourceKind, marketplace_version: null, status: 'production', enabled: true, run_location: 'vm', when_to_call: '', when_not_to_call: '', send: '', returns: '',
    cost_tier: null, can_call: [], is_builtin: false, front_door: null, updated_at: a.updatedAt, config: {} });
  let databaseDown = false;

  beforeEach(async() => {
    await import('@pkg/main/agentsIpc'); // loaded once up front, as in the running main process
    const { DatabaseReadGuard } = await import('@pkg/main/DatabaseReadGuard');
    const { DatabaseUnavailableClassifier } = await import('@pkg/agent/database/DatabaseAvailability');
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    const guard = new DatabaseReadGuard({ classifier: new DatabaseUnavailableClassifier(DB_PORT), probe: async() => { throw refused() }, isShuttingDown: () => false,
      notifyAvailable: () => undefined, logger: { info: () => undefined }, sleep: async(ms) => { if (ms >= 100) await new Promise(() => undefined) }, retryDelaysMs: [1], recoveryMinMs: 100 });
    vi.spyOn(DatabaseReadGuard, 'shared').mockReturnValue(guard);
    vi.spyOn(agentDefinitionService, 'list').mockImplementation(async() => { if (databaseDown) throw refused(); return f.agents.map(toRow) as any });
    databaseDown = false; f.realHandler = true;
    f.agents.push(structuredClone(QA));
  });
  afterEach(() => { vi.restoreAllMocks() });

  it('keeps the 17 loaded agents through an outage, says so, and shows the 18th once the database is back', async() => {
    const wrapper = await openPage();
    expect(installed(wrapper)).toBe('17');
    databaseDown = true;
    await tick();
    expect(installed(wrapper)).toBe('17');
    expect(wrapper.text()).toContain('QA chat Grok');
    expect(wrapper.find('[role="status"]').text()).toMatch(/last loaded list/);
    expect(f.calls.filter(call => MUTATIONS.includes(call))).toEqual([]);

    databaseDown = false; f.agents.push(agent(18, { name: 'Agent eighteen' }));
    await tick();
    expect(installed(wrapper)).toBe('18');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    // Every catalog read the page makes is strict.
    expect(f.listArgs.length).toBeGreaterThan(2);
    expect(f.listArgs.every(arg => (arg as any)?.strict === true)).toBe(true);
  });

  it('keeps the loaded catalog when the reload after a save meets an outage', async() => {
    const wrapper = await openPage();
    await wrapper.findAll('button.dir-edit').find(button => button.text() === 'Agent 1')!.trigger('click');
    databaseDown = true;
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click');
    await flushPromises();
    await wrapper.find('button.back').trigger('click');
    expect(installed(wrapper)).toBe('17');
    expect(wrapper.find('[role="status"]').text()).toMatch(/last loaded list/);
  });

  it('applies a genuinely empty catalog read from the database', async() => {
    const wrapper = await openPage();
    expect(installed(wrapper)).toBe('17');
    f.agents = [];
    await tick();
    expect(installed(wrapper)).toBe('0');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('recovers by itself when the page first opened during the outage', async() => {
    databaseDown = true;
    const wrapper = await openPage();
    await wrapper.findAll('button').find(button => button.text() === 'Manage')!.trigger('click');
    expect(wrapper.text()).toMatch(/temporarily unavailable/);
    databaseDown = false;
    await tick();
    expect(installed(wrapper)).toBe('17');
    expect(wrapper.text()).not.toMatch(/temporarily unavailable/);
  });
});

describe('saving while the catalog read is unavailable (real list handler and read guard)', () => {
  const DB_PORT = 30116;
  const refused = () => Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${ DB_PORT }`), { code: 'ECONNREFUSED', port: DB_PORT, address: '127.0.0.1' });
  const toRow = (a: any) => ({ id: a.id, slug: a.slug, name: a.name, description: a.description, provider: a.provider, model: a.model ?? null, model_slot: a.modelSlot, model_choice: a.modelChoice ?? null,
    prompt_content: a.prompt, source_kind: a.sourceKind, marketplace_version: null, status: 'production', enabled: true, run_location: 'vm', when_to_call: '', when_not_to_call: '', send: '', returns: '',
    cost_tier: null, can_call: [], is_builtin: false, front_door: null, updated_at: a.updatedAt, config: {} });
  let databaseDown = false;
  const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(candidate => candidate.text() === text)!;
  const nameInput = (wrapper: VueWrapper) => wrapper.find('input').element as HTMLInputElement;

  beforeEach(async() => {
    await import('@pkg/main/agentsIpc');
    const { DatabaseReadGuard } = await import('@pkg/main/DatabaseReadGuard');
    const { DatabaseUnavailableClassifier } = await import('@pkg/agent/database/DatabaseAvailability');
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    const guard = new DatabaseReadGuard({ classifier: new DatabaseUnavailableClassifier(DB_PORT), probe: async() => { throw refused() }, isShuttingDown: () => false,
      notifyAvailable: () => undefined, logger: { info: () => undefined }, sleep: async(ms) => { if (ms >= 100) await new Promise(() => undefined) }, retryDelaysMs: [1], recoveryMinMs: 100 });
    vi.spyOn(DatabaseReadGuard, 'shared').mockReturnValue(guard);
    vi.spyOn(agentDefinitionService, 'list').mockImplementation(async() => { if (databaseDown) throw refused(); return f.agents.map(toRow) as any });
    databaseDown = false; f.realHandler = true;
  });
  afterEach(() => { vi.restoreAllMocks() });

  it('keeps the saved name in the open editor when the reload after a successful update is unavailable, and a later save keeps it', async() => {
    const wrapper = await openPage();
    await wrapper.findAll('button.dir-edit').find(candidate => candidate.text() === 'Agent 1')!.trigger('click');
    await wrapper.find('input').setValue('Fresh saved name');
    databaseDown = true;
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(f.agents.find(row => row.id === 'agent-1').name).toBe('Fresh saved name');
    expect(nameInput(wrapper).value).toBe('Fresh saved name');
    expect(wrapper.text()).toContain('Saved.');
    expect(wrapper.text()).not.toMatch(/could not be saved/);

    databaseDown = false;
    await tick();
    expect(nameInput(wrapper).value).toBe('Fresh saved name');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(f.updates.at(-1)).toEqual(['agent-1', expect.objectContaining({ name: 'Fresh saved name' })]);
    expect(f.agents.find(row => row.id === 'agent-1').name).toBe('Fresh saved name');
  });

  it('does not create the agent twice when the reload after a successful create is unavailable', async() => {
    const wrapper = await openPage();
    await button(wrapper, '＋ New agent').trigger('click');
    const [name, slug] = wrapper.findAll('input');
    await name.setValue('Brand new'); await slug.setValue('brand-new');
    databaseDown = true;
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(f.creates).toHaveLength(1);
    expect(wrapper.text()).toContain('Saved.');
    expect(nameInput(wrapper).value).toBe('Brand new');

    // Saving again (still unavailable, then recovered) updates the created agent; it never creates another.
    await name.setValue('Brand new, edited');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    databaseDown = false;
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(f.creates).toHaveLength(1);
    expect(f.updates.map(call => call[0])).toEqual(['created-1', 'created-1']);
    expect(f.agents.filter(row => row.slug === 'brand-new')).toHaveLength(1);
    expect(f.agents.find(row => row.slug === 'brand-new').name).toBe('Brand new, edited');
  });

  it('keeps edits typed while a save was still in flight', async() => {
    const wrapper = await openPage();
    await wrapper.findAll('button.dir-edit').find(candidate => candidate.text() === 'Agent 1')!.trigger('click');
    let release!: () => void;
    f.holdUpdate = new Promise<void>(resolve => { release = resolve });
    await wrapper.find('input').setValue('First save');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    await wrapper.find('input').setValue('Typed during the save');
    release();
    await flushPromises();
    expect(nameInput(wrapper).value).toBe('Typed during the save');
  });

  it('still reopens the fresh saved row when the reload succeeds', async() => {
    const wrapper = await openPage();
    await wrapper.findAll('button.dir-edit').find(candidate => candidate.text() === 'Agent 1')!.trigger('click');
    await wrapper.find('input').setValue('Saved and reloaded');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(nameInput(wrapper).value).toBe('Saved and reloaded');
    expect(wrapper.find('.hero h1').text()).toBe('Saved and reloaded');
    expect(wrapper.text()).toContain('Saved. Model changes apply to new work');
  });
});

describe('a save that finishes after the editor moved to another agent', () => {
  const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(candidate => candidate.text() === text)!;
  const field = (wrapper: VueWrapper) => wrapper.find('input').element as HTMLInputElement;
  const openAgentNamed = async(wrapper: VueWrapper, name: string) => {
    await wrapper.find('button.back').trigger('click');
    await button(wrapper, 'Directory').trigger('click');
    await wrapper.findAll('button.dir-edit').find(candidate => candidate.text() === name)!.trigger('click');
  };
  const held = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } };

  it('never gives a late-created agent\'s identity to the agent opened meanwhile', async() => {
    const wrapper = await openPage();
    await button(wrapper, '＋ New agent').trigger('click');
    const [name, slug] = wrapper.findAll('input');
    await name.setValue('Agent A'); await slug.setValue('agent-a');
    const create = held(); f.holdCreate = create.promise;
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();

    await openAgentNamed(wrapper, 'Agent 2');
    create.release();
    await flushPromises();
    expect(field(wrapper).value).toBe('Agent 2');
    expect(wrapper.text()).not.toContain('Saved.');

    await wrapper.find('input').setValue('Agent 2 renamed');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(f.creates).toHaveLength(1);
    expect(f.updates.map(call => call[0])).toEqual(['agent-2']);
    expect(f.agents.find(row => row.id === 'agent-2').name).toBe('Agent 2 renamed');
    expect(f.agents.find(row => row.slug === 'agent-a').name).toBe('Agent A');
  });

  it('writes a late save to its own agent, with its own profile, and leaves the agent opened meanwhile untouched', async() => {
    f.state.workers = [{ id: 'luna-id', slug: 'codex-luna-worker' }];
    const wrapper = await openPage();
    // A model change saves the worker mapping first; the profile update follows that await.
    await wrapper.findAll('button.dir-edit').find(candidate => candidate.text() === 'Codex LUNA Worker')!.trigger('click');
    await wrapper.find('input').setValue('Luna renamed');
    await wrapper.find('[aria-label="Reasoning effort"]').setValue('high');
    const mapping = held(); f.holdWorkerSet = mapping.promise;
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();

    await openAgentNamed(wrapper, 'Agent 2');
    await wrapper.find('input').setValue('Agent 2 draft');
    mapping.release();
    await flushPromises();
    expect(f.workerSets).toEqual([expect.objectContaining({ slug: 'codex-luna-worker' })]);
    expect(f.updates).toEqual([['luna-id', expect.objectContaining({ name: 'Luna renamed' })]]);
    expect(field(wrapper).value).toBe('Agent 2 draft');
    expect(wrapper.find('.hero h1').text()).toBe('Agent 2 draft');
    expect(f.agents.find(row => row.id === 'agent-2').name).toBe('Agent 2');
  });

  it('still adopts the created identity for the same editor, keeping edits typed while it was created', async() => {
    const wrapper = await openPage();
    await button(wrapper, '＋ New agent').trigger('click');
    const [name, slug] = wrapper.findAll('input');
    await name.setValue('Agent A'); await slug.setValue('agent-a');
    const create = held(); f.holdCreate = create.promise;
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    await name.setValue('Agent A, edited while saving');
    create.release();
    await flushPromises();
    expect(field(wrapper).value).toBe('Agent A, edited while saving');

    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(f.creates).toHaveLength(1);
    expect(f.updates).toEqual([['created-1', expect.objectContaining({ name: 'Agent A, edited while saving' })]]);
  });
});

describe('model validation on Save', () => {
  it('shows the mapping validation for a pinned model on an agent without a worker mapping, and writes nothing', async() => {
    const errors = vi.spyOn(console, 'error');
    const wrapper = await openPage();
    await wrapper.findAll('button.dir-edit').find(candidate => candidate.text() === 'Agent 1')!.trigger('click');
    await wrapper.find('[role="switch"]').trigger('click');
    await wrapper.find('[aria-label="Pinned model"]').setValue('gpt-6-luna');
    const save = wrapper.findAll('button').find(candidate => candidate.text() === 'Save')!;
    await save.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('This exact model cannot be represented by an owner worker mapping');
    expect(f.calls.filter(call => MUTATIONS.includes(call))).toEqual([]);
    expect(save.attributes('disabled')).toBeUndefined();
    expect(errors.mock.calls.flat().map(String).join('\n')).not.toContain('cannot be represented');
    errors.mockRestore();
  });
});
