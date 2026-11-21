// SPDX-License-Identifier: GPL-2.0-or-later
import { BUILTIN_AGENT_RENAMES } from '../../shared/agentJobNames';
import { createHash, randomUUID } from 'node:crypto';

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { SpawnKeyMutex } from '../app/Services/SpawnDedupeGuard';
import { ConversationThreadStore } from '../database/models/ConversationThreadStore';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { LaunchPreviewSession } from './ModelLaunchPreview';
import { effectiveModelChoice, isAgentModelChoice } from '../languagemodels/threadModelChoice';
import { modelRouter } from '../languagemodels/modelRouter';
import { resolveModelSlot } from '../languagemodels/modelSlotRouting';
import { captureWorkerRoute, type WorkerModelBinding, type WorkerModelRoute } from '../languagemodels/workerModelBindings';
import { loadThreadState } from '../nodes/ThreadStateStore';
import { resolveAgentIdentity } from '../utils/agentIdentity';
import { agentDefinitionService } from './AgentDefinitionService';
import { isActiveAgent } from './AgentDirectoryService';
import { resolveDefaultRouteAgent, SULLA_DESKTOP_CHANNEL_ID, SULLA_ROUTE_AGENT_ID } from './ChatAgentRouting';
import { ThreadModelOverridePolicy } from './ThreadModelOverridePolicy';
import { AgentModelStatusRegistry } from './AgentModelStatusRegistry';
import { GraphRegistry } from './GraphRegistry';
import { JobLineageRootChatThreadFinder } from './TabVisibilityResolver';
import { WORKFLOW_SETTINGS_PREFIX, withWorkflowWrite } from './WorkflowWriteAuthority';
import { workerModelRouting } from './WorkerModelRouting';
import { productOwnerWorkflowHistory } from './ProductOwnerWorkflowHistory';
import { isProductOwnerStep, PRODUCT_OWNER, WORKFLOW_STEPS, workflowCompany } from '../../shared/productOwnerWorkflow';
import type { ChatModelPickerSelection, DelegatedWorkflowStep, ProductOwnerStep, WorkflowChoice, WorkflowPlan, WorkflowSaveInput } from '../../shared/productOwnerWorkflow';
import type { ChatOutcomeArchive, WorkflowRunRow } from '../../shared/productOwnerWorkflow';
import type { AgentJob } from '../tools/agents/jobRegistry';
import type { ModelCandidate } from '../languagemodels/modelRouter';
import type { ResultReference } from '../../shared/agentResults/AgentResultCard';

interface LeadSelectionMetadata {
  routedAgentId?: string;
  delegatedJobId?: string;
  workerModelTask?: { jobId?: string };
  workerModelChatOverride?: boolean;
  modelChoice?: unknown;
  agent?: { model?: string; provider?: string; effort?: string };
}
interface StoredChoice extends WorkflowChoice {
  revision: string;
  binding?: WorkerModelBinding;
  /** Prevent reusing an override after deleting and recreating the same agent slug. */
  agentId?: string;
}

async function findWorkflowTask(threadId: string) {
  const job = await agentJobProvider.jobs.findByTaskThread(threadId);
  if (!job) return undefined;
  const taskIndex = job.tasks.findIndex(task => task.threadId === threadId);
  return taskIndex >= 0 ? { job, taskIndex } : undefined;
}
const lineage = new JobLineageRootChatThreadFinder(findWorkflowTask);
const choiceKey = (threadId: string, step: ProductOwnerStep) => `${ WORKFLOW_SETTINGS_PREFIX }${ threadId }.${ step }`;

function isWorkflowThreadId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

async function read(threadId: string, step: ProductOwnerStep): Promise<StoredChoice | null> {
  return SullaSettingsModel.get(choiceKey(threadId, step), null);
}

async function rootState(threadId: string) {
  return GraphRegistry.get(threadId)?.state ?? await loadThreadState(threadId);
}

async function workflowRoot(threadId: string, chatThreadId?: string) {
  const live = GraphRegistry.get(threadId)?.state;
  const state = live ?? await loadThreadState(threadId);
  const metadata = state?.metadata as (NonNullable<typeof state>['metadata'] & LeadSelectionMetadata) | undefined;
  const rememberedAgent = metadata?.routedAgentId?.trim();
  const identity = resolveAgentIdentity(metadata);
  if (metadata?.isSubAgent || metadata?.productOwnerWorkflowStep || metadata?.delegatedJobId ||
      metadata?.workerModelTask?.jobId || await findWorkflowTask(threadId)) {
    return { state, rememberedAgent, canEdit: false };
  }
  // A live graph or named backend persona is authoritative. A cold legacy shell can contain
  // only the shared desktop channel. Recover the exact selected persona from its linked chat.
  const namedIdentity = identity && identity !== SULLA_DESKTOP_CHANNEL_ID ? identity : undefined;
  const namedRoute = rememberedAgent && rememberedAgent !== SULLA_DESKTOP_CHANNEL_ID ? rememberedAgent : undefined;
  const agent = live
    ? identity
    : namedIdentity || namedRoute || await ConversationThreadStore.findSelectedAgent(threadId, chatThreadId);
  return { state, rememberedAgent, canEdit: agent === PRODUCT_OWNER };
}

async function builderSlug(threadId: string) {
  return (await read(threadId, 'build'))?.agentSlug ?? 'coding-manager';
}

async function shippedWorkflowAgent(slug: string | null | undefined): Promise<string | undefined> {
  const rename = BUILTIN_AGENT_RENAMES.find(([, next]) => next === slug);
  if (!rename) return slug ?? undefined;
  const agent = await agentDefinitionService.findBySlug(rename[1]);
  return agent && !agent.is_builtin ? rename[0] : rename[1];
}

async function permittedCallee(ownerSlug: string, slug: string) {
  const [owner, target] = await Promise.all([agentDefinitionService.findBySlug(ownerSlug), agentDefinitionService.findBySlug(slug)]);
  if (!owner || !target || !isActiveAgent(target) || target.id === owner.id) throw new Error('Choose an enabled agent from the delegating agent’s team.');
  const team = owner.can_call ?? [];
  if (team.length && !team.includes('*') && !team.includes(target.slug)) throw new Error('This agent is outside the delegating agent’s team.');
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

async function approvedRoute(slug: string, id: string, saved: StoredChoice, candidates: ModelCandidate[]): Promise<WorkerModelRoute | undefined> {
  if (!saved.binding) return undefined;
  return captureWorkerRoute(slug, id, { [slug]: { ...saved.binding, agentId: id, candidates: await modelRouter.workerLaunchCandidates(candidates) } });
}

function namedInlineSource(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = Object.entries(value).filter(([key, field]) =>
    ['source', 'code', 'function', 'html'].includes(key) && typeof field === 'string' && field.trim());
  if (!fields.length) return undefined;
  return fields.length === 1 ? fields[0][1] : JSON.stringify(Object.fromEntries(fields));
}

function savedInlineImplementation(job: AgentJob, threadId: string) {
  const saved = job.results?.find(result => result.threadId === threadId && result.status === 'completed')?.result;
  const output = (saved as { output?: unknown } | undefined)?.output;
  // With a custom result schema, return_result stores the result fields directly.
  const artifact = namedInlineSource(output) ?? namedInlineSource(saved)
    ?? (typeof output === 'string' && output.trim() ? output : undefined)
    ?? (typeof saved === 'string' && saved.trim() ? saved : undefined);
  if (!artifact) return undefined;
  const bytes = Buffer.byteLength(artifact, 'utf8');
  if (bytes > 64 * 1024) return undefined;
  return {
    digest: createHash('sha256').update(artifact, 'utf8').digest('hex'),
    bytes,
    artifact,
  };
}

async function completedImplementation(ref: ResultReference | undefined, root: string) {
  if (!ref || !isWorkflowThreadId(ref.jobId) || !Number.isInteger(ref.taskIndex) || ref.taskIndex < 0) return undefined;
  const job = await agentJobProvider.jobs.job(ref.jobId);
  const task = job?.tasks[ref.taskIndex];
  if (!job || !task?.threadId || task.workflowStep !== 'implementation' || task.status !== 'completed'
      || await lineage.findRootChatThreadId(task.threadId) !== root) return undefined;
  return { task, inline: savedInlineImplementation(job, task.threadId) };
}

interface WorkflowDelegationScope {
  caller: string;
  root: string;
  lead: boolean;
}
export class ProductOwnerWorkflowService {
  private readonly writes = new SpawnKeyMutex();

  async getProductOwnerWorkflow(threadId: string, includePreviews = true, picker?: ChatModelPickerSelection): Promise<WorkflowPlan> {
    if (!isWorkflowThreadId(threadId)) throw new Error('Invalid chat.');
    const chatThreadId = picker?.chatThreadId;
    const { state, rememberedAgent, canEdit } = await workflowRoot(threadId, isWorkflowThreadId(chatThreadId) ? chatThreadId : undefined);
    const leadModels = AgentModelStatusRegistry.responsesFor(threadId) ?? state?.metadata?.workflowResponseModels ?? [];
    if (!canEdit) return { canEdit: false, providers: [], agents: [], steps: {}, leadModels };
    const [providers, definitions, defaults, ...overrides] = await Promise.all([
      modelRouter.providerInfo(true), agentDefinitionService.list(), modelRouter.getEditableState(true),
      ...WORKFLOW_STEPS.map(step => read(threadId, step.id)),
    ]);
    const displayAgents = definitions.filter(isActiveAgent).map(agent => ({
      slug: agent.slug, name: agent.name,
    }));
    const counts = new Map<string, number>();
    for (const agent of displayAgents) {
      const key = agent.name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const agents = displayAgents.map(agent => ({
      ...agent, name: counts.get(agent.name.toLowerCase()) === 1 ? agent.name : `${ agent.name } · ${ agent.slug }`,
    }));
    const steps: WorkflowPlan['steps'] = {};
    const builder = (overrides[WORKFLOW_STEPS.findIndex(step => step.id === 'build')] as StoredChoice | null)?.agentSlug ?? 'coding-manager';
    const previews = new LaunchPreviewSession(providers, defaults);
    const pickerPolicy = new ThreadModelOverridePolicy();
    const selection = pickerPolicy.parse(picker);
    const pickedAgent = typeof picker?.agentId === 'string' ? picker.agentId.trim() : '';
    const defaultAgent = includePreviews && !pickedAgent && selection.mode === 'default' ? await resolveDefaultRouteAgent(true) : undefined;
    // A model-only selection carries no persona. Dispatch keeps the remembered graph route
    // when present, otherwise it starts with the ordinary Desktop assistant.
    const nextLead = pickedAgent || defaultAgent?.graphAgentId ||
      (selection.mode === 'explicit' ? rememberedAgent || SULLA_DESKTOP_CHANNEL_ID : PRODUCT_OWNER);
    await Promise.all(WORKFLOW_STEPS.map(async(step, index) => {
      const saved = overrides[index] as StoredChoice | null;
      const slug = saved?.agentSlug ?? await shippedWorkflowAgent(step.agent);
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

      if (!includePreviews) return;
      const entry = steps[step.id]!;
      const lead = step.id === 'lead';
      if (lead && nextLead !== PRODUCT_OWNER) {
        const name = agents.find(item => item.slug === nextLead)?.name ?? defaultAgent?.name ??
          (nextLead === SULLA_DESKTOP_CHANNEL_ID || nextLead === SULLA_ROUTE_AGENT_ID ? 'Sulla' : nextLead);
        entry.preview = {
          status: 'deferred', agent: nextLead, candidates: [],
          reason: selection.mode === 'explicit'
            ? `The chat picker selects ${ selection.model } for the next message with ${ name }.`
            : `The chat picker routes the next message to ${ name }.`,
        };
        return;
      }
      const meta = (lead ? state?.metadata : undefined) as LeadSelectionMetadata | undefined;
      const chatPin = lead && (selection.mode === 'unchanged' ? Boolean(meta?.workerModelChatOverride) : selection.mode === 'explicit');
      const agentConfig = lead ? pickerPolicy.apply(meta?.agent, selection) : undefined;
      const leadChoice = defaultAgent ? defaultAgent.modelChoice : meta?.modelChoice;
      const chatBinding = !chatPin && saved?.binding;
      const deferred = !slug;
      if (slug && (!definition || !isActiveAgent(definition) || (saved?.agentId && saved.agentId !== definition.id) || (!lead && !entry.allowedAgents.includes(slug)))) {
        entry.preview = { status: 'blocked', agent: slug, candidates: [], reason: 'This agent is unavailable, was replaced, or is outside the delegating agent’s team.' };
        return;
      }
      if (deferred && !chatBinding) {
        entry.preview = { status: 'deferred', candidates: [], reason: 'The build lead chooses the agent at handoff. Its model and fallback order depend on that choice.' };
        return;
      }
      let choice = definition?.model_choice ?? undefined;
      if (lead && (chatPin || (!chatBinding && !entry.inherited.length))) {
        try {
          choice = effectiveModelChoice({ metadata: { modelChoice: leadChoice }, agentChoice: choice, provider: agentConfig?.provider, model: agentConfig?.model, effort: agentConfig?.effort });
        } catch (error) {
          entry.preview = { status: 'blocked', agent: slug ?? undefined, candidates: [], reason: error instanceof Error ? error.message : 'Invalid chat model selection.' };
          return;
        }
      }
      const slot = lead && resolveModelSlot(state?.metadata as Record<string, unknown> | undefined) === 'subconscious' ? 'subconscious' : 'agents';
      const preview = await previews.preview({ slug: slug ?? undefined, agentId: definition?.id, choice }, {
        slot,
        ...(chatBinding ? { binding: { ...chatBinding, agentId: definition?.id || 'unsaved' }, source: 'Uses the model order saved for this step in this chat.' } : {}),
        ...(chatPin ? { ignoreSaved: true, source: 'The chat model picker controls the next lead turn.' } :
          !chatBinding && !entry.inherited.length && isAgentModelChoice(leadChoice) ? { source: 'Uses this chat’s saved model choice.' } : {}),
      });
      if (preview.status === 'ready' && (deferred || saved?.independentReview)) {
        preview.status = 'deferred';
        preview.reason = [preview.reason, deferred ? 'The build lead chooses the agent at handoff.' : '',
          saved?.independentReview ? 'At handoff, Sulla excludes the companies that produced the completed implementation.' : ''].filter(Boolean).join(' ');
      }
      entry.preview = preview;
    }));
    return { canEdit: true, providers, agents, steps, leadModels };
  }

  async saveProductOwnerWorkflow(input: WorkflowSaveInput): Promise<WorkflowPlan> {
    const { threadId, step, expectedRevision } = input ?? {};
    if (!isWorkflowThreadId(threadId) || !isProductOwnerStep(step) || typeof expectedRevision !== 'string') throw new Error('Invalid Workflow setting.');
    if (!SullaSettingsModel.ready) throw new Error('Settings are still connecting. Try again shortly.');
    await this.writes.run(threadId, async() => {
      if (!(await workflowRoot(threadId)).canEdit) throw new Error('Open a Product Owner chat to change its workflow.');
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
      const stored: StoredChoice = { ...choice, ...(target ? { agentSlug: target.slug } : {}), revision, agentId: target?.id,
        ...(connections ? { binding: { agentId: target?.id ?? '', editToken: revision, revision: 1, candidates: choice.candidates, connections } } : {}) };
      await withWorkflowWrite(() => SullaSettingsModel.set(choiceKey(threadId, step), stored, 'json'));
    });
    return this.getProductOwnerWorkflow(threadId);
  }

  async productOwnerLeadRoute(threadId: string): Promise<WorkerModelRoute | undefined> {
    const saved = await read(threadId, 'lead');
    if (!saved?.binding) return undefined;
    const lead = await agentDefinitionService.findBySlug(PRODUCT_OWNER);
    if (!lead || !isActiveAgent(lead)) throw new Error('Product Owner is unavailable.');
    return approvedRoute(lead.slug, lead.id, saved, saved.candidates);
  }

  async readAssignedImplementationSource(threadId: string) {
    if (!isWorkflowThreadId(threadId)) return undefined;
    const own = await findWorkflowTask(threadId);
    const task = own?.job.tasks[own.taskIndex];
    const source = task?.workflowStep === 'review' && task.followUpOf && task.inlineReviewDigest
      ? { ...task.followUpOf, digest: task.inlineReviewDigest }
      : task?.workflowStep === 'acceptance' ? task.inlineAcceptanceSource : undefined;
    if (!source) return undefined;
    const root = await lineage.findRootChatThreadId(threadId);
    if (!root || root === threadId) return undefined;
    const implementation = (await completedImplementation(source, root))?.inline;
    if (!implementation || implementation.digest !== source.digest) return undefined;
    return {
      sourceBase64: Buffer.from(implementation.artifact, 'utf8').toString('base64'),
      sha256: implementation.digest,
      byteLength: implementation.bytes,
    };
  }

  async productOwnerDelegationScope(caller: string, threadId: string) {
    if (!isWorkflowThreadId(threadId)) return undefined;
    const own = await findWorkflowTask(threadId);
    if (!own && caller === PRODUCT_OWNER) return { caller, root: threadId, lead: true };
    if (!own) return undefined;
    const task = own.job.tasks[own.taskIndex];
    if (task?.agentId !== caller || !(task.workflowStep === 'build' || (caller === 'coding-manager' && own.job.parentAgentId === PRODUCT_OWNER))) return undefined;
    const root = await lineage.findRootChatThreadId(threadId);
    if (root && root !== threadId) return { caller, root, lead: false };
  }

  async productOwnerDelegation(scope: WorkflowDelegationScope, slug: string | undefined, requested: DelegatedWorkflowStep | undefined, followUpOf?: ResultReference, implementationSource?: ResultReference) {
    const inferred = scope.lead ? WORKFLOW_STEPS.find(step => step.id !== 'lead' && step.agent === slug)?.id : undefined;
    const step = requested ?? inferred;
    if (!step || step === 'lead') return undefined;
    const allowed = scope.lead ? ['mockup', 'build', 'acceptance'] : ['implementation', 'review'];
    if (!allowed.includes(step)) throw new Error('This workflow step is assigned by another agent.');
    let inlineAcceptance: { bytes: number; digest: string; source: ResultReference } | undefined;
    if (implementationSource !== undefined) {
      if (step !== 'acceptance') throw new Error('implementationSource is only for acceptance testing.');
      const original = await completedImplementation(implementationSource, scope.root);
      if (!original?.inline) throw new Error('Acceptance needs a completed implementation with saved inline source in this chat. Use its exact jobId and taskIndex.');
      inlineAcceptance = { bytes: original.inline.bytes, digest: original.inline.digest, source: { jobId: implementationSource.jobId, taskIndex: implementationSource.taskIndex } };
    }
    const saved = await read(scope.root, step);
    const fallbackSlug = await shippedWorkflowAgent(WORKFLOW_STEPS.find(item => item.id === step)?.agent);
    if (!saved || (!saved.agentSlug && !saved.binding)) {
      if (slug) return { step, inlineAcceptance };
      if (!fallbackSlug) throw new Error('Choose an eligible agent from the team directory or assign one in AI Team.');
      const agent = await permittedCallee(scope.caller, fallbackSlug);
      return { step, slug: agent.slug, inlineAcceptance };
    }
    const agent = await permittedCallee(scope.caller, saved.agentSlug ?? slug ?? fallbackSlug ?? '');
    if (saved.agentId && saved.agentId !== agent.id) throw new Error('This chat’s assigned agent was replaced. Update the Workflow selection.');
    let candidates = saved.candidates;
    let inlineReview: { bytes: number; digest: string } | undefined;
    if (saved.independentReview) {
      // The explicit follow-up must point to an implementation job in this exact chat.
      const original = await completedImplementation(followUpOf, scope.root);
      if (!original) {
        throw new Error('Independent review needs the exact completed implementation task in this chat. Pass its jobId and taskIndex as followUpOf.');
      }
      const models = original.task.responseModels;
      const authors = new Set(models?.map(model => workflowCompany(model.provider ?? '')));
      if (!authors.size || authors.has(undefined)) throw new Error('Sulla could not verify the implementation provider. Review is waiting for your choice.');
      candidates = candidates.filter(candidate => !authors.has(workflowCompany(candidate.provider)));
      if (!candidates.length) throw new Error('No configured review provider differs from the implementation providers. Update the Review model list for this chat.');
      if (original.inline) inlineReview = { bytes: original.inline.bytes, digest: original.inline.digest };
    }
    return { step, slug: agent.slug, route: await approvedRoute(agent.slug, agent.id, saved, candidates), inlineReview, inlineAcceptance };
  }

  /** Read historical runtime provenance only when the task belongs to the open chat. */
  async readWorkflowExecution(threadId: string, input: unknown) {
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

  /** The existing bounded lineage query preserves recent terminal work beyond Live Agents' display window. */
  async readWorkflowHistory(threadId: string): Promise<WorkflowRunRow[]> {
    return productOwnerWorkflowHistory.history(threadId);
  }

  async readChatOutcomes(threadId: string, conversationId: string): Promise<ChatOutcomeArchive> {
    return productOwnerWorkflowHistory.outcomes(threadId, conversationId);
  }
}

export const productOwnerWorkflow = new ProductOwnerWorkflowService();
