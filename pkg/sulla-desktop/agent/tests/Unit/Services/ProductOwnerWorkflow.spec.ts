// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  settings: new Map<string, unknown>(), states: new Map<string, any>(), jobs: [] as any[],
  definitions: [] as any[], validate: vi.fn(), writes: vi.fn(),
}));
vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { ready: true, get: async(key: string, fallback: unknown) => f.settings.get(key) ?? fallback,
    set: async(key: string, value: unknown, cast: string) => { f.writes(key, value, cast); f.settings.set(key, JSON.parse(JSON.stringify(value))) } },
}));
vi.mock('../../../app/Providers/AgentJobServiceProvider', () => ({
  agentJobProvider: {
    jobs: {
      lineageForParentThread: async() => f.jobs,
      findByTaskThread: async(threadId: string) => f.jobs.find(job => job.tasks.some((task: any) => task.threadId === threadId)),
      job: async(id: string) => f.jobs.find(job => job.jobId === id),
    },
  },
}));
vi.mock('../../../nodes/ThreadStateStore', () => ({ loadThreadState: async(id: string) => f.states.get(id) ?? null }));
vi.mock('../../../services/GraphRegistry', () => ({ GraphRegistry: { get: () => undefined } }));
vi.mock('../../../services/AgentDefinitionService', () => ({
  agentDefinitionService: { findBySlug: async(slug: string) => f.definitions.find(def => def.slug === slug), list: async() => f.definitions },
}));
vi.mock('../../../services/WorkerModelRouting', () => ({
  workerModelRouting: { validateSubscriptionCandidates: (...args: unknown[]) => f.validate(...args) },
}));
vi.mock('../../../languagemodels/modelRouter', () => ({
  modelRouter: {
    providerInfo: async() => [],
    getEditableState: async() => ({ workerBindings: {} }),
    workerLaunchCandidates: async(candidates: unknown[]) => [...candidates],
  },
}));

import { getProductOwnerWorkflow, productOwnerDelegation, productOwnerDelegationScope, productOwnerLeadRoute, readWorkflowExecution, readWorkflowHistory, saveProductOwnerWorkflow } from '../../../services/ProductOwnerWorkflow';
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
  return { jobId, parentThreadId, parentAgentId, tasks, createdAt: 1_000 };
}

beforeEach(() => {
  f.settings.clear();
  f.states.clear();
  f.writes.mockClear();
  f.validate.mockReset().mockResolvedValue({ codex: 'existing-codex', 'claude-code': 'existing-claude' });
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
  it('stores only this chat’s supported ordered route and changes only later launches', async() => {
    const init = await getProductOwnerWorkflow(root);
    expect(init.canEdit).toBe(true);
    expect(init.steps.implementation?.allowedAgents).toEqual(['worker-a', 'worker-b']);
    const before = await productOwnerDelegation(scope, 'worker-a', 'implementation');
    expect(before).toEqual({ step: 'implementation' });
    const updated = await saveProductOwnerWorkflow({
      threadId: root, step: 'implementation', expectedRevision: '',
      choice: { agentSlug: 'worker-b', candidates: [sol, sonnet] },
    });
    const captured = await productOwnerDelegation(scope, 'worker-a', 'implementation');
    expect(f.validate).toHaveBeenCalledWith([sol, sonnet]);
    expect(captured).toMatchObject({ slug: 'worker-b', route: { agentId: 'def-worker-b', selected: 0, candidates: [sol, sonnet] } });
    expect(updated.steps.implementation?.choice).toEqual({ agentSlug: 'worker-b', candidates: [sol, sonnet], independentReview: undefined });
    expect(f.writes).toHaveBeenCalledWith('productOwnerWorkflow.chat-a.implementation', expect.anything(), 'json');
    expect((await getProductOwnerWorkflow('chat-b')).steps.implementation?.choice.candidates).toEqual([]);
    expect((await productOwnerDelegation({ ...scope, root: 'chat-b' }, 'worker-a', 'implementation'))?.route).toBeUndefined();
    expect(f.jobs[1].tasks[0].agentId).toBe('worker-a');
    expect(f.jobs[1].tasks[0].responseModels).toEqual([response]);
    await saveProductOwnerWorkflow({ threadId: root, step: 'implementation', expectedRevision: updated.steps.implementation!.revision, choice: null });
    expect((await productOwnerDelegation(scope, 'worker-a', 'implementation'))?.route).toBeUndefined();
    expect(captured?.route?.candidates).toEqual([sol, sonnet]);
  });

  it('rejects stale writes, invalid agents, disabled agents and chats led by a different agent', async() => {
    const input = { threadId: root, step: 'implementation' as const, expectedRevision: '', choice: { agentSlug: 'worker-b', candidates: [] } };
    await expect(saveProductOwnerWorkflow({ ...input, threadId: 'other-chat' })).rejects.toThrow('Product Owner chat');
    await expect(saveProductOwnerWorkflow({ ...input, choice: { agentSlug: 'retired', candidates: [] } })).rejects.toThrow('enabled agent');
    await expect(saveProductOwnerWorkflow({ ...input, choice: { agentSlug: 'builder', candidates: [] } })).rejects.toThrow('outside');
    await saveProductOwnerWorkflow(input);
    await expect(saveProductOwnerWorkflow(input)).rejects.toThrow('settings changed');
    expect(() => assertWorkflowWrite('productOwnerWorkflow.chat-a.implementation')).toThrow('Workflow panel');
  });

  it('uses real ownership, allows overrides for recognized direct handoffs and never assigns unrelated calls', async() => {
    expect(await productOwnerDelegationScope('worker-a', 'author')).toBeUndefined();
    expect(await productOwnerDelegationScope('coding-manager', 'other-chat')).toBeUndefined();
    expect(await productOwnerDelegationScope('coding-manager', 'manager-child')).toEqual(scope);
    const owner = (await productOwnerDelegationScope('account-manager', root))!;
    await saveProductOwnerWorkflow({ threadId: root, step: 'build', expectedRevision: '', choice: { agentSlug: 'builder', candidates: [sol] } });
    expect(await productOwnerDelegation(owner, 'coding-manager', undefined)).toMatchObject({ step: 'build', slug: 'builder' });
    expect(await productOwnerDelegation(owner, 'worker-b', undefined)).toBeUndefined();
    await expect(productOwnerDelegation(owner, 'worker-b', 'implementation')).rejects.toThrow('another agent');
    expect((await getProductOwnerWorkflow(root)).steps.implementation?.allowedAgents).toEqual(['worker-b']);
  });

  it('binds the lead’s model for new turns and the delegated party by exact definition ID', async() => {
    await saveProductOwnerWorkflow({ threadId: root, step: 'lead', expectedRevision: '', choice: { candidates: [sol, sonnet] } });
    expect(await productOwnerLeadRoute(root)).toMatchObject({ slug: 'account-manager', candidates: [sol, sonnet] });
    await saveProductOwnerWorkflow({ threadId: root, step: 'implementation', expectedRevision: '', choice: { agentSlug: 'worker-b', candidates: [sol] } });
    f.definitions.find(def => def.slug === 'worker-b').id = 'another-definition';
    await expect(productOwnerDelegation(scope, 'worker-a', 'implementation')).rejects.toThrow('was replaced');
  });

  it('filters independent review across all actual implementation companies and fails closed without proof', async() => {
    await saveProductOwnerWorkflow({
      threadId: root, step: 'review', expectedRevision: '',
      choice: { agentSlug: 'worker-b', candidates: [sonnet, sol], independentReview: true },
    });
    const ref = { jobId: 'implementation', taskIndex: 0 };
    expect(await productOwnerDelegation(scope, 'worker-a', 'review', ref)).toMatchObject({ route: { candidates: [sol] } });
    await expect(productOwnerDelegation(scope, 'worker-a', 'review')).rejects.toThrow('exact completed implementation');
    f.jobs[1].tasks[0].responseModels = [{ ...response, provider: 'anthropic' }, { ...sol, provider: 'OpenAI Codex', source: 'resolved' }];
    await expect(productOwnerDelegation(scope, 'worker-a', 'review', ref)).rejects.toThrow('No configured review provider');
    f.jobs[1].tasks[0].responseModels = [{ ...response, provider: 'Unknown CLI' }];
    await expect(productOwnerDelegation(scope, 'worker-a', 'review', ref)).rejects.toThrow('verify the implementation provider');
    f.jobs[1].tasks[0].responseModels = undefined;
    await expect(productOwnerDelegation(scope, 'worker-a', 'review', ref)).rejects.toThrow('verify the implementation provider');
  });

  it('shows durable terminal handoffs and model evidence only within the owning chat', async() => {
    const ref = { jobId: 'implementation', taskIndex: 0 };
    const rows = await readWorkflowHistory(root);
    expect(rows[1]).toMatchObject({ parentJobId: 'manager', state: 'done', responseModels: [response] });
    expect(await readWorkflowExecution(root, ref)).toEqual([response]);
    expect(await readWorkflowExecution('chat-b', ref)).toEqual([]);
  });
});
