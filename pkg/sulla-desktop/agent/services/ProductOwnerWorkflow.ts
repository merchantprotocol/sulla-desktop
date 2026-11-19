// SPDX-License-Identifier: GPL-2.0-or-later
import { randomUUID } from 'node:crypto';

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { AgentLineageIndex } from '../app/Services/AgentLineageIndex';
import { SpawnKeyMutex } from '../app/Services/SpawnDedupeGuard';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { modelRouter } from '../languagemodels/modelRouter';
import { captureWorkerRoute, type WorkerModelBinding, type WorkerModelRoute } from '../languagemodels/workerModelBindings';
import { loadThreadState } from '../nodes/ThreadStateStore';
import { resolveAgentIdentity } from '../utils/agentIdentity';
import { agentDefinitionService } from './AgentDefinitionService';
import { isActiveAgent } from './AgentDirectoryService';
import { AgentModelStatusRegistry } from './AgentModelStatusRegistry';
import { GraphRegistry } from './GraphRegistry';
import { JobLineageRootChatThreadFinder } from './TabVisibilityResolver';
import { WORKFLOW_SETTINGS_PREFIX, withWorkflowWrite } from './WorkflowWriteAuthority';
import { workerModelRouting } from './WorkerModelRouting';
import { isProductOwnerStep, PRODUCT_OWNER, WORKFLOW_STEPS, workflowCompany } from '../../shared/productOwnerWorkflow';

import type { DelegatedWorkflowStep, ProductOwnerStep, WorkflowChoice, WorkflowPlan, WorkflowSaveInput } from '../../shared/productOwnerWorkflow';
import type { WorkflowRunRow } from '../../shared/productOwnerWorkflow';
import type { AgentRowState } from '../../shared/agentState/AgentStateSnapshot';
import type { AgentJobTask } from '../tools/agents/jobRegistry';
import type { ModelCandidate } from '../languagemodels/modelRouter';
import type { ResultReference } from '../../shared/agentResults/AgentResultCard';

interface StoredChoice extends WorkflowChoice {
  revision: string;
  binding?: WorkerModelBinding;
  /** Prevent reusing an override after deleting and recreating the same agent slug. */
  agentId?: string;
}

const workflowWrites = new SpawnKeyMutex();
async function findWorkflowTask(threadId: string) {
  const job = await agentJobProvider.jobs.findByTaskThread(threadId);
  if (!job) return undefined;
  const taskIndex = job.tasks.findIndex(task => task.threadId === threadId);
  return taskIndex >= 0 ? { job, taskIndex } : undefined;
}
const lineage = new JobLineageRootChatThreadFinder(findWorkflowTask);
const choiceKey = (threadId: string, step: ProductOwnerStep) => `${ WORKFLOW_SETTINGS_PREFIX }${ threadId }.${ step }`;

export function isWorkflowThreadId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

async function read(threadId: string, step: ProductOwnerStep): Promise<StoredChoice | null> {
  return SullaSettingsModel.get(choiceKey(threadId, step), null);
}

async function rootState(threadId: string) {
  return GraphRegistry.get(threadId)?.state ?? await loadThreadState(threadId);
}

function rootAgent(state: Awaited<ReturnType<typeof rootState>>): string {
  return String(resolveAgentIdentity(state?.metadata));
}

async function builderSlug(threadId: string) {
  return (await read(threadId, 'build'))?.agentSlug ?? 'coding-manager';
}

async function permittedCallee(ownerSlug: string, slug: string) {
  const [owner, target] = await Promise.all([agentDefinitionService.findBySlug(ownerSlug), agentDefinitionService.findBySlug(slug)]);
  if (!owner || !target || !isActiveAgent(target) || slug === ownerSlug) throw new Error('Choose an enabled agent from the delegating agent’s team.');
  const team = owner.can_call ?? [];
  if (team.length && !team.includes('*') && !team.includes(slug)) throw new Error('This agent is outside the delegating agent’s team.');
  return target;
}

function cleanChoice(input: WorkflowChoice): WorkflowChoice {
  if (!input || !Array.isArray(input.candidates) || input.candidates.length > 10) throw new Error('Choose up to ten models.');
  const agentSlug = input.agentSlug;
  if (agentSlug !== undefined && (typeof agentSlug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(agentSlug))) throw new Error('Choose a valid agent.');
  const candidates = input.candidates.map(row => {
    if (!row || typeof row.provider !== 'string' || typeof row.model !== 'string' || !row.model.trim() || (row.effort !== undefined && typeof row.effort !== 'string')) throw new Error('Invalid model or effort.');
    return { provider: row.provider, model: row.model, ...(row.effort !== undefined ? { effort: row.effort } : {}) };
  });
  if (new Set(candidates.map(row => JSON.stringify([row.provider, row.model, row.effort ?? '']))).size !== candidates.length) throw new Error('Each model and effort pair can appear once in the priority list.');
  return { agentSlug, candidates, ...(input.independentReview === true ? { independentReview: true } : {}) };
}

export async function getProductOwnerWorkflow(threadId: string): Promise<WorkflowPlan> {
  if (!isWorkflowThreadId(threadId)) throw new Error('Invalid chat.');
  const state = await rootState(threadId);
  const leadModels = AgentModelStatusRegistry.responsesFor(threadId) ?? state?.metadata?.workflowResponseModels ?? [];
  if (rootAgent(state) !== PRODUCT_OWNER || await findWorkflowTask(threadId)) return { canEdit: false, providers: [], agents: [], steps: {}, leadModels };
  const [providers, definitions, defaults, ...overrides] = await Promise.all([
    modelRouter.providerInfo(), agentDefinitionService.list(), modelRouter.getEditableState(),
    ...WORKFLOW_STEPS.map(step => read(threadId, step.id)),
  ]);
  const agents = definitions.filter(isActiveAgent).map(({ slug, name }) => ({ slug, name }));
  const steps: WorkflowPlan['steps'] = {};
  const builder = (overrides[WORKFLOW_STEPS.findIndex(step => step.id === 'build')] as StoredChoice | null)?.agentSlug ?? 'coding-manager';
  WORKFLOW_STEPS.forEach((step, index) => {
    const saved = overrides[index] as StoredChoice | null;
    const slug = saved?.agentSlug ?? step.agent;
    const binding = slug ? defaults.workerBindings?.[slug] : undefined;
    const definition = definitions.find(item => item.slug === slug);
    steps[step.id] = {
      choice: { agentSlug: saved?.agentSlug, candidates: saved?.candidates ?? [], independentReview: saved?.independentReview },
      inherited: binding && !binding.pendingPublication && definition?.id === binding.agentId ? binding.candidates : [],
      revision: saved?.revision ?? '',
      allowedAgents: (() => {
        const owner = step.id === 'implementation' || step.id === 'review' ? builder : PRODUCT_OWNER;
        const roster = definitions.find(agent => agent.slug === owner)?.can_call ?? [];
        return agents.filter(agent => agent.slug !== owner && (!roster.length || roster.includes('*') || roster.includes(agent.slug))).map(agent => agent.slug);
      })(),
    };
  });
  return { canEdit: true, providers, agents, steps, leadModels };
}

export async function saveProductOwnerWorkflow(input: WorkflowSaveInput): Promise<WorkflowPlan> {
  const { threadId, step, expectedRevision } = input ?? {};
  if (!isWorkflowThreadId(threadId) || !isProductOwnerStep(step) || typeof expectedRevision !== 'string') throw new Error('Invalid Workflow setting.');
  if (!SullaSettingsModel.ready) throw new Error('Settings are still connecting. Try again shortly.');
  await workflowWrites.run(threadId, async() => {
    if (rootAgent(await rootState(threadId)) !== PRODUCT_OWNER || await findWorkflowTask(threadId)) throw new Error('Open a Product Owner chat to change its workflow.');
    if (((await read(threadId, step))?.revision ?? '') !== expectedRevision) throw new Error('Workflow settings changed. Reload this panel before saving.');
    if (input.choice === null) {
      await withWorkflowWrite(() => SullaSettingsModel.set(choiceKey(threadId, step), { revision: randomUUID(), candidates: [] }, 'json'));
      return;
    }
    const choice = cleanChoice(input.choice);
    if (step === 'lead' && choice.agentSlug) throw new Error('Use the chat’s agent picker to change who leads the conversation.');
    if (choice.independentReview && (step !== 'review' || !choice.candidates.length)) throw new Error('Choose an ordered model list for independent review.');
    const parent = step === 'implementation' || step === 'review' ? await builderSlug(threadId) : PRODUCT_OWNER;
    const target = choice.agentSlug ? await permittedCallee(parent, choice.agentSlug) : null;
    const connections = choice.candidates.length ? await workerModelRouting.validateSubscriptionCandidates(choice.candidates) : undefined;
    const revision = randomUUID();
    // Bind to the selected definition at launch when the owner kept the delegator's agent choice.
    const stored: StoredChoice = { ...choice, revision, agentId: target?.id,
      ...(connections ? { binding: { agentId: target?.id ?? '', editToken: revision, revision: 1, candidates: choice.candidates, connections } } : {}) };
    await withWorkflowWrite(() => SullaSettingsModel.set(choiceKey(threadId, step), stored, 'json'));
  });
  return getProductOwnerWorkflow(threadId);
}

async function approvedRoute(slug: string, id: string, saved: StoredChoice, candidates: ModelCandidate[]): Promise<WorkerModelRoute | undefined> {
  if (!saved.binding) return undefined;
  return captureWorkerRoute(slug, id, { [slug]: { ...saved.binding, agentId: id, candidates: await modelRouter.workerLaunchCandidates(candidates) } });
}

export async function productOwnerLeadRoute(threadId: string): Promise<WorkerModelRoute | undefined> {
  const saved = await read(threadId, 'lead');
  if (!saved?.binding) return undefined;
  const lead = await agentDefinitionService.findBySlug(PRODUCT_OWNER);
  if (!lead || !isActiveAgent(lead)) throw new Error('Product Owner is unavailable.');
  return approvedRoute(lead.slug, lead.id, saved, saved.candidates);
}

export async function productOwnerDelegationScope(caller: string, threadId: string) {
  if (!isWorkflowThreadId(threadId)) return undefined;
  const own = await findWorkflowTask(threadId);
  if (!own && caller === PRODUCT_OWNER) return { caller, root: threadId, lead: true };
  if (!own) return undefined;
  const task = own.job.tasks[own.taskIndex];
  if (task?.agentId !== caller || !(task.workflowStep === 'build' || (caller === 'coding-manager' && own.job.parentAgentId === PRODUCT_OWNER))) return undefined;
  const root = await lineage.findRootChatThreadId(threadId);
  if (root && root !== threadId) return { caller, root, lead: false };
}

export type WorkflowDelegationScope = NonNullable<Awaited<ReturnType<typeof productOwnerDelegationScope>>>;

export async function productOwnerDelegation(scope: WorkflowDelegationScope, slug: string | undefined, requested: DelegatedWorkflowStep | undefined, followUpOf?: ResultReference) {
  const inferred = scope.lead ? WORKFLOW_STEPS.find(step => step.id !== 'lead' && step.agent === slug)?.id : undefined;
  const step = requested ?? inferred;
  if (!step || step === 'lead') return undefined;
  const allowed = scope.lead ? ['mockup', 'build', 'acceptance'] : ['implementation', 'review'];
  if (!allowed.includes(step)) throw new Error('This workflow step is assigned by another agent.');
  const saved = await read(scope.root, step);
  if (!saved || (!saved.agentSlug && !saved.binding)) return { step };
  const fallbackSlug = WORKFLOW_STEPS.find(item => item.id === step)?.agent;
  const agent = await permittedCallee(scope.caller, saved.agentSlug ?? slug ?? fallbackSlug ?? '');
  if (saved.agentId && saved.agentId !== agent.id) throw new Error('This chat’s assigned agent was replaced. Update the Workflow selection.');
  let candidates = saved.candidates;
  if (saved.independentReview) {
    // The explicit follow-up must point to an implementation job in this exact chat.
    const original = followUpOf && await agentJobProvider.jobs.job(followUpOf.jobId);
    const task = original && original.tasks[followUpOf!.taskIndex];
    if (!task?.threadId || task.workflowStep !== 'implementation' || task.status !== 'completed' || await lineage.findRootChatThreadId(task.threadId) !== scope.root) {
      throw new Error('Independent review needs the exact completed implementation task in this chat. Pass its jobId and taskIndex as followUpOf.');
    }
    const models = task.responseModels;
    const authors = new Set(models?.map(model => workflowCompany(model.provider ?? '')));
    if (!authors.size || authors.has(undefined)) throw new Error('Sulla could not verify the implementation provider. Review is waiting for your choice.');
    candidates = candidates.filter(candidate => !authors.has(workflowCompany(candidate.provider)));
    if (!candidates.length) throw new Error('No configured review provider differs from the implementation providers. Update the Review model list for this chat.');
  }
  return { step, slug: agent.slug, route: await approvedRoute(agent.slug, agent.id, saved, candidates) };
}

/** Read historical runtime provenance only when the task belongs to the open chat. */
export async function readWorkflowExecution(threadId: string, input: unknown) {
  if (!isWorkflowThreadId(threadId)) throw new Error('Invalid chat.');
  if (input === null) return AgentModelStatusRegistry.responsesFor(threadId) ?? (await rootState(threadId))?.metadata?.workflowResponseModels ?? [];
  const ref = input as ResultReference;
  if (!ref || !isWorkflowThreadId(ref.jobId) || !Number.isInteger(ref.taskIndex) || ref.taskIndex < 0) throw new Error('Invalid workflow execution.');
  const job = await agentJobProvider.jobs.job(ref.jobId);
  const task = job?.tasks[ref.taskIndex];
  const child = task?.threadId;
  if (!child || child === threadId || await lineage.findRootChatThreadId(child) !== threadId) return [];
  if (task.responseModels) return task.responseModels;
  if (task.finishedAt || ['completed', 'error', 'stopped'].includes(task.status)) return [];
  return AgentModelStatusRegistry.responsesFor(child) ?? (await rootState(child))?.metadata?.workflowResponseModels ?? [];
}

const workflowStates: Record<AgentJobTask['status'], AgentRowState> = {
  queued: 'queued', running: 'working', parked: 'parked', lost: 'lost',
  completed: 'done', blocked: 'blocked', error: 'failed', stopped: 'stopped',
};

/** The existing bounded lineage query preserves recent terminal work beyond Live Agents' display window. */
export async function readWorkflowHistory(threadId: string): Promise<WorkflowRunRow[]> {
  if (!isWorkflowThreadId(threadId)) throw new Error('Invalid chat.');
  const jobs = await agentJobProvider.jobs.lineageForParentThread(threadId);
  const index = new AgentLineageIndex(jobs);
  return jobs.flatMap(job => {
    const parent = index.lineage(job);
    if (parent.rootThreadId !== threadId && !job.parentJobId) return [];
    return job.tasks.map((task, taskIndex) => ({
      key: `${ job.jobId }:${ taskIndex }`,
      jobId: job.jobId, taskIndex, rootThreadId: threadId,
      parentJobId: job.parentJobId ?? parent.parentJobId,
      parentTaskIndex: job.parentTaskIndex ?? parent.parentTaskIndex,
      agentId: task.agentId, label: task.label,
      state: workflowStates[task.status],
      startedAt: new Date(task.startedAt ?? job.createdAt).toISOString(),
      endedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
      stateReason: task.waitReason ?? null,
      responseModels: task.responseModels,
      workflowStep: task.workflowStep, followUpOf: task.followUpOf,
    }));
  });
}
