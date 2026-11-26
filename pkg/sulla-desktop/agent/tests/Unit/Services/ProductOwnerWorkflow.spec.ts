// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  settings: new Map<string, unknown>(), states: new Map<string, any>(), jobs: [] as any[],
  definitions: [] as any[], validate: vi.fn(), writes: vi.fn(),
  live: new Map<string, any>(), savedAgent: vi.fn(), resolve: vi.fn(),
  editable: { workerBindings: {} } as any,
}));
vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { ready: true, get: async(key: string, fallback: unknown) => f.settings.get(key) ?? fallback,
    set: async(key: string, value: unknown, cast: string) => { f.writes(key, value, cast); f.settings.set(key, JSON.parse(JSON.stringify(value))) } },
}));
vi.mock('../../../app/Providers/AgentJobServiceProvider', () => ({
  agentJobProvider: {
    jobs: {
      lineageForParentThread: async() => f.jobs,
      findByTaskThread: async(threadId: string) => f.jobs.find(job => job.tasks.some((task: any) => task?.threadId === threadId)),
      job: async(id: string) => f.jobs.find(job => job.jobId === id),
    },
  },
}));
vi.mock('../../../nodes/ThreadStateStore', () => ({ loadThreadState: async(id: string) => f.states.get(id) ?? null }));
vi.mock('../../../services/GraphRegistry', () => ({ GraphRegistry: { get: (id: string) => f.live.get(id) } }));
vi.mock('../../../database/models/ConversationThreadStore', () => ({
  ConversationThreadStore: {
    findSelectedAgent: (id: string, chatId?: string) => f.savedAgent(id, chatId),
    loadReportMessages: async() => [],
  },
}));
vi.mock('../../../services/AgentDefinitionService', () => ({
  agentDefinitionService: { findBySlug: async(slug: string) => f.definitions.find(def => def.slug === slug), list: async() => f.definitions },
}));
vi.mock('../../../services/WorkerModelRouting', () => ({
  isWorkerAccountTemporarilyUnavailable: () => false,
  workerModelRouting: { validateSubscriptionCandidates: (...args: unknown[]) => f.validate(...args),
    orderNewRoute: async(route: unknown) => route,
    resolveRouteOnce: async(route: { candidates: unknown[] }) => route.candidates,
  },
}));
vi.mock('../../../languagemodels/modelRouter', () => ({
  modelRouter: {
    providerInfo: async() => [],
    resolve: (...args: unknown[]) => f.resolve(...args),
    getEditableState: async() => f.editable,
    workerLaunchCandidates: async(candidates: unknown[]) => [...candidates],
  },
}));

import { productOwnerWorkflow } from '../../../services/ProductOwnerWorkflow';
import { assertWorkflowWrite } from '../../../services/WorkflowWriteAuthority';

const sol = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'max' };
const sonnet = { provider: 'claude-code', model: 'claude-sonnet', effort: 'high' };
const response = { ...sonnet, provider: 'Claude Code', source: 'resolved' as const };
const root = 'chat-a';
const scope = { root, caller: 'coding-manager', lead: false };
function definition(slug: string, can_call: string[] = [], extra = {}) {
  return { slug, id: `def-${slug}`, name: slug, status: 'production', enabled: true, can_call, ...extra };
}
function job(jobId: string, parentThreadId: string, tasks: any[], parentAgentId = 'coding-manager') {
  return { jobId, parentThreadId, parentAgentId, tasks, results: [], createdAt: 1_000 };
}

beforeEach(() => {
  f.settings.clear();
  f.states.clear();
  f.live.clear();
  f.savedAgent.mockReset().mockResolvedValue(null);
  f.resolve.mockReset().mockResolvedValue([]);
  f.writes.mockClear();
  f.validate.mockReset().mockResolvedValue({ codex: 'existing-codex', 'claude-code': 'existing-claude' });
  f.editable = { workerBindings: {} };
  f.states.set(root, { metadata: { agentId: 'account-manager' } });
  f.states.set('chat-b', { metadata: { agentId: 'account-manager' } });
  f.states.set('other-chat', { metadata: { agentId: 'sulla-desktop' } });
  f.definitions = [
    definition('account-manager', ['coding-manager', 'builder']),
    definition('coding-manager', ['worker-a', 'worker-b']), definition('builder', ['worker-b']),
    definition('worker-a'), definition('worker-b'), definition('retired', [], { enabled: false }),
  ];
  f.jobs = [
    job('manager', root, [{ agentId: 'coding-manager', label: 'Build', threadId: 'manager-child', status: 'completed', workflowStep: 'build' }], 'account-manager'),
    job('implementation', 'manager-child', [{ agentId: 'worker-a', label: 'First patch', threadId: 'author', status: 'completed', workflowStep: 'implementation', responseModels: [response] }]),
  ];
});

describe('Product Owner chat routing', () => {
  it('previews and delegates the shipped mockup step to the exact retained built-in only', async() => {
    const lead = { root, caller: 'account-manager', lead: true };
    f.definitions[0].can_call = ['mockup-designer'];
    const retained = definition('mockup-designer', [], { is_builtin: true });
    f.definitions.push(retained);
    f.resolve.mockResolvedValue([sol]);
    const preview = async() => (await productOwnerWorkflow.getProductOwnerWorkflow(root)).steps.mockup?.preview;
    expect(await preview()).toMatchObject({ agent: retained.slug, candidates: [sol] });
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'mockup')).resolves.toMatchObject({ slug: retained.slug });
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, 'designer', 'mockup')).rejects.toThrow();
    f.definitions.pop();
    f.definitions.push(definition('mockup-designer'));
    expect(await preview()).toMatchObject({ status: 'blocked', agent: 'designer' });
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'mockup')).rejects.toThrow();
  });

  it('stores only this chat’s supported ordered route and changes only later launches', async() => {
    const init = await productOwnerWorkflow.getProductOwnerWorkflow(root);
    expect(init.canEdit).toBe(true);
    expect(init.steps.implementation?.allowedAgents).toEqual(['worker-a', 'worker-b']);
    const before = await productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'implementation');
    expect(before).toEqual({ step: 'implementation' });
    const updated = await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'implementation', expectedRevision: '',
      choice: { agentSlug: 'worker-b', candidates: [sol, sonnet] },
    });
    const captured = await productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'implementation');
    expect(f.validate).toHaveBeenCalledWith([sol, sonnet]);
    expect(captured).toMatchObject({ slug: 'worker-b', route: { agentId: 'def-worker-b', selected: 0, candidates: [sol, sonnet] } });
    expect(updated.steps.implementation?.choice).toEqual({ agentSlug: 'worker-b', candidates: [sol, sonnet], independentReview: undefined });
    expect(f.writes).toHaveBeenCalledWith('productOwnerWorkflow.chat-a.implementation', expect.anything(), 'json');
    expect((await productOwnerWorkflow.getProductOwnerWorkflow('chat-b')).steps.implementation?.choice.candidates).toEqual([]);
    expect((await productOwnerWorkflow.productOwnerDelegation({ ...scope, root: 'chat-b' }, 'worker-a', 'implementation'))?.route).toBeUndefined();
    expect(f.jobs[1].tasks[0].agentId).toBe('worker-a');
    expect(f.jobs[1].tasks[0].responseModels).toEqual([response]);
    await productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: root, step: 'implementation', expectedRevision: updated.steps.implementation!.revision, choice: null });
    expect((await productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'implementation'))?.route).toBeUndefined();
    expect(captured?.route?.candidates).toEqual([sol, sonnet]);
  });

  it('keeps a per-chat AI Team route ahead of later Team default edits', async() => {
    f.editable = { workerBindings: { 'worker-b': { agentId: 'def-worker-b', revision: 1, editToken: 'global-1', candidates: [sonnet] } } };
    await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'implementation', expectedRevision: '',
      choice: { agentSlug: 'worker-b', candidates: [sol] },
    });
    f.editable = { workerBindings: { 'worker-b': { agentId: 'def-worker-b', revision: 2, editToken: 'global-2', candidates: [sonnet, sol] } } };
    const next = await productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'implementation');
    expect(next?.route?.candidates).toEqual([sol]);
    expect(f.jobs[1].tasks[0]).toMatchObject({ agentId: 'worker-a', responseModels: [response] });
  });

  it('rejects stale writes, invalid agents, disabled agents and chats led by a different agent', async() => {
    const input = { threadId: root, step: 'implementation' as const, expectedRevision: '', choice: { agentSlug: 'worker-b', candidates: [] } };
    await expect(productOwnerWorkflow.saveProductOwnerWorkflow({ ...input, threadId: 'other-chat' })).rejects.toThrow('Product Owner chat');
    await expect(productOwnerWorkflow.saveProductOwnerWorkflow({ ...input, choice: { agentSlug: 'retired', candidates: [] } })).rejects.toThrow('enabled agent');
    await expect(productOwnerWorkflow.saveProductOwnerWorkflow({ ...input, choice: { agentSlug: 'builder', candidates: [] } })).rejects.toThrow('outside');
    await productOwnerWorkflow.saveProductOwnerWorkflow(input);
    await expect(productOwnerWorkflow.saveProductOwnerWorkflow(input)).rejects.toThrow('settings changed');
    expect(() => assertWorkflowWrite('productOwnerWorkflow.chat-a.implementation')).toThrow('Workflow panel');
  });

  it('loads and saves a cold restored Product Owner root through the exact durable chat selection', async() => {
    f.states.set(root, { metadata: { agentId: 'sulla-desktop', wsChannel: 'sulla-desktop' } });
    f.savedAgent.mockImplementation(async(id: string) => id === root ? 'account-manager' : null);
    expect((await productOwnerWorkflow.getProductOwnerWorkflow(root)).canEdit).toBe(true);
    expect(f.savedAgent).toHaveBeenCalledWith(root, undefined);
    expect(f.writes).not.toHaveBeenCalled();

    const saved = await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'lead', expectedRevision: '', choice: { candidates: [sol] },
    });
    expect(saved.steps.lead?.preview).toMatchObject({ candidates: [sol] });
    expect(f.writes).toHaveBeenCalledWith(`productOwnerWorkflow.${ root }.lead`, expect.anything(), 'json');
    expect(f.states.get(root).metadata.agentId).toBe('sulla-desktop');
  });

  it('compares an unsent selected persona and a model-only pick against the next route', async() => {
    f.states.delete(root);
    f.savedAgent.mockResolvedValue('account-manager');
    f.resolve.mockResolvedValue([{ provider: sol.provider, model: sol.model }]);
    const modelOnly = { modelSelection: 'explicit' as const, providerId: sol.provider, modelId: sol.model };
    const plan = await productOwnerWorkflow.getProductOwnerWorkflow(root, true, modelOnly);
    expect(plan.canEdit).toBe(true);
    expect(plan.steps.lead?.preview).toMatchObject({
      status: 'deferred', agent: 'sulla-desktop', candidates: [],
      reason: expect.stringContaining(sol.model + ' for the next message with Sulla'),
    });
    const selectedOwner = await productOwnerWorkflow.getProductOwnerWorkflow(root, true, { ...modelOnly, agentId: 'account-manager', chatThreadId: 'renderer-tab-a' });
    expect(f.savedAgent).toHaveBeenLastCalledWith(root, 'renderer-tab-a');
    expect(selectedOwner.steps.lead?.preview).toMatchObject({
      status: 'waiting', agent: 'account-manager', candidates: [{ provider: sol.provider, model: sol.model }],
      reason: expect.stringContaining('chat model picker'),
    });
    expect(f.resolve).toHaveBeenCalledWith('agents', { mode: 'pin', provider: sol.provider, model: sol.model }, expect.anything());
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('rejects an unrelated cold chat and treats a real live persona as authoritative over a saved pick', async() => {
    f.savedAgent.mockResolvedValue('worker-a');
    const claimedOwner = { modelSelection: 'default' as const, agentId: 'account-manager' };
    expect((await productOwnerWorkflow.getProductOwnerWorkflow('other-chat', true, claimedOwner)).canEdit).toBe(false);
    await expect(productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: 'other-chat', step: 'lead', expectedRevision: '', choice: null })).rejects.toThrow('Open a Product Owner chat');

    f.savedAgent.mockClear().mockResolvedValue('account-manager');
    f.live.set(root, { state: { metadata: { agentId: 'worker-a', routedAgentId: 'account-manager' } } });
    expect((await productOwnerWorkflow.getProductOwnerWorkflow(root, true, claimedOwner)).canEdit).toBe(false);
    f.live.set(root, { state: { metadata: { agentId: 'sulla-desktop' } } });
    expect((await productOwnerWorkflow.getProductOwnerWorkflow(root, true, claimedOwner)).canEdit).toBe(false);
    expect(f.savedAgent).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('fails closed when durable linked chats disagree about the selected agent', async() => {
    f.states.delete(root);
    f.savedAgent.mockRejectedValue(new Error('Ambiguous linked chats'));
    const picker = { modelSelection: 'default' as const, agentId: 'account-manager' };
    await expect(productOwnerWorkflow.getProductOwnerWorkflow(root, true, picker)).rejects.toThrow('Ambiguous linked chats');
    await expect(productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: root, step: 'lead', expectedRevision: '', choice: null })).rejects.toThrow('Ambiguous linked chats');
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('excludes delegated visible children before checking their linked chat selections', async() => {
    f.savedAgent.mockResolvedValue('account-manager');
    f.states.set('graph-worker', { metadata: { agentId: 'account-manager', delegatedJobId: 'no-longer-present' } });
    const picker = { modelSelection: 'default' as const, agentId: 'account-manager' };
    for (const threadId of ['author', 'graph-worker']) {
      expect((await productOwnerWorkflow.getProductOwnerWorkflow(threadId, true, picker)).canEdit).toBe(false);
      await expect(productOwnerWorkflow.saveProductOwnerWorkflow({ threadId, step: 'lead', expectedRevision: '', choice: null })).rejects.toThrow('Open a Product Owner chat');
    }
    expect(f.savedAgent).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('uses real ownership, allows overrides for recognized direct handoffs and never assigns unrelated calls', async() => {
    expect(await productOwnerWorkflow.productOwnerDelegationScope('worker-a', 'author')).toBeUndefined();
    expect(await productOwnerWorkflow.productOwnerDelegationScope('coding-manager', 'other-chat')).toBeUndefined();
    expect(await productOwnerWorkflow.productOwnerDelegationScope('coding-manager', 'manager-child')).toEqual(scope);
    const owner = (await productOwnerWorkflow.productOwnerDelegationScope('account-manager', root))!;
    await productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: root, step: 'build', expectedRevision: '', choice: { agentSlug: 'builder', candidates: [sol] } });
    expect(await productOwnerWorkflow.productOwnerDelegation(owner, 'coding-manager', undefined)).toMatchObject({ step: 'build', slug: 'builder' });
    expect(await productOwnerWorkflow.productOwnerDelegation(owner, 'worker-b', undefined)).toBeUndefined();
    await expect(productOwnerWorkflow.productOwnerDelegation(owner, 'worker-b', 'implementation')).rejects.toThrow('another agent');
    expect((await productOwnerWorkflow.getProductOwnerWorkflow(root)).steps.implementation?.allowedAgents).toEqual(['worker-b']);
  });

  it('authorizes a legacy allowlist by the same definition in the picker and the actual handoff', async() => {
    const lead = { root, caller:'account-manager', lead:true };
    f.definitions[0].can_call = ['mockup-designer'];
    f.definitions.push(definition('designer', [], { is_builtin:true }));
    const offered = async() => (await productOwnerWorkflow.getProductOwnerWorkflow(root, false)).steps.mockup?.allowedAgents;
    expect(await offered()).toEqual(['designer']);
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, 'mockup-designer', 'mockup')).resolves.toMatchObject({ slug:'designer' });

    f.definitions.push(definition('mockup-designer')); // Exact custom identity wins over the historical alias.
    expect(await offered()).toEqual(['mockup-designer']);
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, 'designer', 'mockup')).rejects.toThrow('outside');
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, 'mockup-designer', 'mockup')).resolves.toMatchObject({ step:'mockup' });
    f.definitions.at(-1).enabled = false;
    expect(await offered()).toEqual([]);
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, 'designer', 'mockup')).rejects.toThrow('outside');
  });

  it('fills a tagged lead handoff without requiring a legacy agent name', async() => {
    const lead = { root, caller: 'account-manager', lead: true };
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'build'))
      .resolves.toEqual({ step: 'build', slug: 'coding-manager' });
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, undefined, 'implementation'))
      .rejects.toThrow('Choose an eligible agent');
    await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'implementation', expectedRevision: '',
      choice: { agentSlug: 'worker-b', candidates: [sol] },
    });
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, undefined, 'implementation'))
      .resolves.toMatchObject({ step: 'implementation', slug: 'worker-b', route: { candidates: [sol] } });
  });

  it('binds the lead’s model for new turns and the delegated party by exact definition ID', async() => {
    await productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: root, step: 'lead', expectedRevision: '', choice: { candidates: [sol, sonnet] } });
    expect(await productOwnerWorkflow.productOwnerLeadRoute(root)).toMatchObject({ slug: 'account-manager', candidates: [sol, sonnet] });
    await productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: root, step: 'implementation', expectedRevision: '', choice: { agentSlug: 'worker-b', candidates: [sol] } });
    f.definitions.find(def => def.slug === 'worker-b').id = 'another-definition';
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'implementation')).rejects.toThrow('was replaced');
  });

  it('filters independent review across all actual implementation companies and fails closed without proof', async() => {
    await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'review', expectedRevision: '',
      choice: { agentSlug: 'worker-b', candidates: [sonnet, sol], independentReview: true },
    });
    const ref = { jobId: 'implementation', taskIndex: 0 };
    expect(await productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'review', ref)).toMatchObject({ route: { candidates: [sol] } });
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'review')).rejects.toThrow('exact completed implementation');
    f.jobs[1].tasks[0].responseModels = [{ ...response, provider: 'anthropic' }, { ...sol, provider: 'OpenAI Codex', source: 'resolved' }];
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'review', ref)).rejects.toThrow('No configured review provider');
    f.jobs[1].tasks[0].responseModels = [{ ...response, provider: 'Unknown CLI' }];
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'review', ref)).rejects.toThrow('verify the implementation provider');
    f.jobs[1].tasks[0].responseModels = undefined;
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'review', ref)).rejects.toThrow('verify the implementation provider');
  });

  it('binds the independent reviewer to the original saved inline bytes', async() => {
    const code = 'function count() {\r\n  return 1;\r\n}\r\n';
    f.jobs[1].results = [{ threadId: 'author', status: 'completed', result: { source: code, notes: 'exclude' } }];
    await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'review', expectedRevision: '',
      choice: { agentSlug: 'worker-b', candidates: [sonnet, sol], independentReview: true },
    });
    const result = await productOwnerWorkflow.productOwnerDelegation(scope, undefined, 'review', { jobId: 'implementation', taskIndex: 0 });
    expect(result?.inlineReview).toEqual({ bytes: Buffer.byteLength(code), digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result?.route?.candidates).toEqual([sol]);
    const reviewer = { threadId: 'reviewer', workflowStep: 'review', status: 'running',
      followUpOf: { jobId: 'implementation', taskIndex: 0 }, inlineReviewDigest: result?.inlineReview?.digest };
    f.jobs.push(job('review-job', 'manager-child', [reviewer]));
    expect(await productOwnerWorkflow.readAssignedImplementationSource('reviewer')).toEqual({
      sourceBase64: Buffer.from(code, 'utf8').toString('base64'),
      byteLength: Buffer.byteLength(code),
      sha256: result?.inlineReview?.digest,
    });
    reviewer.inlineReviewDigest = undefined;
    expect(await productOwnerWorkflow.readAssignedImplementationSource('reviewer')).toBeUndefined();
  });

  it('gives every saved reviewer selection its own identity, stable until the next save', async() => {
    const choice = { agentSlug: 'worker-b', candidates: [sonnet, sol], independentReview: true };
    const ref = { jobId: 'implementation', taskIndex: 0 };
    const review = async() => (await productOwnerWorkflow.productOwnerDelegation(scope, undefined, 'review', ref))!.route!;

    const saved = await productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: root, step: 'review', expectedRevision: '', choice });
    const first = await review();
    // An unchanged selection keeps its identity, so a retry finds the reviewer already assigned.
    expect((await review()).editToken).toBe(first.editToken);

    // Saving the same agent and models again is a new decision. The numeric revision repeats.
    await productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: root, step: 'review', expectedRevision: saved.steps.review!.revision, choice });
    const second = await review();
    expect(second).toMatchObject({ agentId: first.agentId, revision: first.revision, candidates: first.candidates });
    expect(second.editToken).toBeTruthy();
    expect(second.editToken).not.toBe(first.editToken);
  });

  it('applies the delegating agent’s team to a named specialist once the chat override is cleared', async() => {
    const saved = await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'implementation', expectedRevision: '', choice: { agentSlug: 'worker-b', candidates: [sol] },
    });
    await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'implementation', expectedRevision: saved.steps.implementation!.revision, choice: null,
    });

    // worker-a is on Coding Manager's team; builder is enabled but belongs to the Product Owner's.
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, 'worker-a', 'implementation')).resolves.toEqual({ step: 'implementation' });
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, 'builder', 'implementation')).rejects.toThrow('outside the delegating agent');
    await expect(productOwnerWorkflow.productOwnerDelegation(scope, 'retired', 'implementation')).rejects.toThrow('enabled agent');
    // A chat that never had an override follows the same rule.
    await expect(productOwnerWorkflow.productOwnerDelegation({ ...scope, root: 'chat-b' }, 'builder', 'review')).rejects.toThrow('outside the delegating agent');

    // The step's default specialist is checked the same way: the Product Owner's team has no designer.
    const lead = { root, caller: 'account-manager', lead: true };
    f.definitions.push(definition('designer', [], { is_builtin: true }));
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'mockup')).rejects.toThrow('outside the delegating agent');
    f.definitions.find(def => def.slug === 'account-manager').can_call.push('designer');
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'mockup')).resolves.toEqual({ step: 'mockup', slug: 'designer' });
  });

  it('reads a saved implementation from a job whose earlier task and result slots are empty', async() => {
    const code = 'export const total = 1;\n';
    const author = { agentId: 'worker-a', label: 'Second patch', threadId: 'late-author', status: 'completed', workflowStep: 'implementation', responseModels: [response] };
    const sparse = job('sparse', 'manager-child', [null, author]);
    sparse.results = [null, { threadId: 'late-author', status: 'completed', result: { source: code } }] as any;
    f.jobs.push(sparse);
    const source = { jobId: 'sparse', taskIndex: 1 };
    const lead = { root, caller: 'account-manager', lead: true };

    const launch = await productOwnerWorkflow.productOwnerDelegation(lead, 'builder', 'acceptance', undefined, source);
    // The saved position is the task's identity: index 1 stays index 1.
    expect(launch?.inlineAcceptance).toEqual({ source, bytes: Buffer.byteLength(code), digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await productOwnerWorkflow.readWorkflowExecution(root, source)).toEqual([response]);
    expect(await productOwnerWorkflow.productOwnerDelegationScope('worker-a', 'late-author')).toBeUndefined();

    const tester = { threadId: 'sparse-tester', workflowStep: 'acceptance', status: 'running', inlineAcceptanceSource: { ...source, digest: launch!.inlineAcceptance!.digest } };
    f.jobs.push(job('sparse-test-job', root, [null, tester], 'account-manager'));
    expect(await productOwnerWorkflow.readAssignedImplementationSource('sparse-tester')).toEqual({
      sourceBase64: Buffer.from(code, 'utf8').toString('base64'), byteLength: Buffer.byteLength(code), sha256: launch!.inlineAcceptance!.digest,
    });
  });

  it('attaches the exact saved implementation to the configured acceptance tester', async() => {
    const code = '<p>Résumé</p>\r\n  ';
    f.jobs[1].results = [{ threadId: 'author', status: 'completed', result: { output: { html: code, notes: 'exclude' } } }];
    const source = { jobId: 'implementation', taskIndex: 0 };
    const lead = { root, caller: 'account-manager', lead: true };

    await productOwnerWorkflow.saveProductOwnerWorkflow({
      threadId: root, step: 'acceptance', expectedRevision: '',
      choice: { agentSlug: 'builder', candidates: [sol, sonnet] },
    });
    const receipt = await productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'acceptance', undefined, source);
    expect(receipt).toMatchObject({
      slug: 'builder',
      route: { candidates: [sol, sonnet] },
      inlineAcceptance: { source, bytes: Buffer.byteLength(code), digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    f.jobs[1].results[0].result.output = code;
    expect((await productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'acceptance', undefined, source))?.inlineAcceptance)
      .toEqual(receipt?.inlineAcceptance);
    f.jobs[1].results[0].result = code;
    expect((await productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'acceptance', undefined, source))?.inlineAcceptance)
      .toEqual(receipt?.inlineAcceptance);
    f.jobs[1].results[0].result = { source: code, status: 'completed', output: 'this is only the summary' };
    expect((await productOwnerWorkflow.productOwnerDelegation(lead, undefined, 'acceptance', undefined, source))?.inlineAcceptance)
      .toEqual(receipt?.inlineAcceptance);
    expect((await productOwnerWorkflow.productOwnerDelegation(lead, 'builder', 'acceptance'))?.inlineAcceptance).toBeUndefined();
    await expect(productOwnerWorkflow.productOwnerDelegation({ ...lead, root: 'chat-b' }, 'builder', 'acceptance', undefined, source))
      .rejects.toThrow('in this chat');
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, 'builder', 'acceptance', undefined, { ...source, taskIndex: -1 }))
      .rejects.toThrow('exact jobId and taskIndex');
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, 'builder', 'build', undefined, source))
      .rejects.toThrow('only for acceptance');
    f.jobs[1].tasks[0].status = 'running';
    await expect(productOwnerWorkflow.productOwnerDelegation(lead, 'builder', 'acceptance', undefined, source))
      .rejects.toThrow('completed implementation');
  });

  it('streams exact bytes only to their assigned tester and detects a changed result', async() => {
    const code = '<p>Résumé</p>\r\n  ';
    f.jobs[1].results = [{ threadId: 'author', status: 'completed', result: { output: code } }];
    const ref = { jobId: 'implementation', taskIndex: 0 };
    const lead = { root, caller: 'account-manager', lead: true };
    const launch = await productOwnerWorkflow.productOwnerDelegation(lead, 'builder', 'acceptance', undefined, ref);
    const digest = launch!.inlineAcceptance!.digest;
    const task = { threadId: 'assigned-tester', workflowStep: 'acceptance', status: 'running',
      inlineAcceptanceSource: { ...ref, digest } };
    f.jobs.push(job('test-job', root, [task], 'account-manager'));
    f.jobs.push(job('other-job', 'chat-b', [{ ...task, threadId: 'other-tester' }], 'account-manager'));

    const stream = await productOwnerWorkflow.readAssignedImplementationSource('assigned-tester');
    expect(stream).toEqual({
      sourceBase64: Buffer.from(code, 'utf8').toString('base64'),
      byteLength: Buffer.byteLength(code),
      sha256: digest,
    });
    expect(await productOwnerWorkflow.readAssignedImplementationSource(root)).toBeUndefined();
    expect(await productOwnerWorkflow.readAssignedImplementationSource('author')).toBeUndefined();
    expect(await productOwnerWorkflow.readAssignedImplementationSource('other-tester')).toBeUndefined();
    f.jobs[1].results[0].result.output = code.trimEnd();
    expect(await productOwnerWorkflow.readAssignedImplementationSource('assigned-tester')).toBeUndefined();
  });

  it('shows durable terminal handoffs and model evidence only within the owning chat', async() => {
    const ref = { jobId: 'implementation', taskIndex: 0 };
    const rows = await productOwnerWorkflow.readWorkflowHistory(root);
    expect(rows[1]).toMatchObject({ parentJobId: 'manager', state: 'done', responseModels: [response] });
    expect(await productOwnerWorkflow.readWorkflowExecution(root, ref)).toEqual([response]);
    expect(await productOwnerWorkflow.readWorkflowExecution('chat-b', ref)).toEqual([]);
  });

  it('keeps valid handoffs and outcomes when a legacy job has a null task slot', async() => {
    f.jobs.push(job('legacy', root, [null, {
      agentId: 'worker-b', label: 'Recovered review', threadId: 'legacy-review', status: 'completed', workflowStep: 'review',
    }], 'account-manager'));

    const history = await productOwnerWorkflow.readWorkflowHistory(root);
    expect(history).toContainEqual(expect.objectContaining({ jobId: 'legacy', taskIndex: 1, label: 'Recovered review' }));
    expect(history).not.toContainEqual(expect.objectContaining({ jobId: 'legacy', taskIndex: 0 }));
    await expect(productOwnerWorkflow.readChatOutcomes(root, root)).resolves.toMatchObject({ history });
  });
});
