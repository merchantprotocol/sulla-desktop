// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DeferredStallInput } from '../../app/Services/DeferredStallInput';
import { StopPrincipal } from '../../app/ValueObjects/StopPrincipal';
import { BaseTool, ToolResponse } from '../base';
import { extractAgentTurnOutcome } from './agentTurnOutcome';
import {
  assertContractSchema,
  contractFooter,
  normalizeContract,
  type AgentContractSpec,
} from './contract';
import { deliverJobCompletion, returnedJobResult } from './jobDelivery';
import { emitSubAgentExchange } from './jobExchange';
import {
  abortJob,
  completeJob,
  createJob,
  failJob,
  findTaskByThread,
  getAllJobs,
  getJob,
  getTaskAbortSignal,
  markCompletionDelivered,
  markTaskCompletionDelivered,
  recordTaskCompletion,
  stoppedTaskResult,
  MAX_SUBAGENT_DEPTH,
  registerJobWatcher,
  releaseJobWatcher,
  resolveAgentDepth,
  updateJobTask,
} from './jobRegistry';
import { agentJobLifecycle } from '../../services/AgentJobLifecycleService';
import { agentWaitProvider } from '../../services/AgentWaitServices';
import { AgentWaitRequest } from '../../services/AgentWaitRequest';
import { DelegatedTurnSettlementPolicy, MissingContractAfterReminderError } from '../../services/DelegatedTurnSettlementPolicy';
import { DelegatedFreshTurnRunner } from '../../services/DelegatedFreshTurnRunner';
import { threadSlug } from './threadSlug';
import { DEFAULT_AGENT_RUN_LOCATION } from '../../database/models/AgentDefinitionModel';
import {
  delegationSituation,
  delegationTaskId,
  safeFinishDelegation,
  safeFinishDelegationByRef,
  safeMarkDelegationsDelivered,
  safeRejectDelegation,
  safeStartDelegation,
  type AgentDelegationStart,
} from '../../database/models/AgentDelegationModel';
import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import { saveThreadState } from '../../nodes/ThreadStateStore';
import { combineAborts } from '../../services/AbortService';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { completionInboxStore, notifyAgentCompletionsReady } from '../../services/AgentCompletionInbox';
import { agentDefinitionService } from '../../services/AgentDefinitionService';
import { ParkedContainerLifecycle } from '../../services/ParkedContainerLifecycle';
import { agentExecutionReadiness, executionAbort } from '../../services/AgentExecutionReadiness';
import { DelegatedTurnPreparer } from '../../services/DelegatedTurnPreparer';
import { DelegatedWakeSettlementPolicy } from '../../services/DelegatedWakeSettlementPolicy';
import { FailedManagerCompletionRerouter } from '../../services/FailedManagerCompletionRerouter';
import { trackHiddenAgentRun } from '../../services/HiddenAgentRuns';
import { HiddenAgentTaskRunner } from '../../services/HiddenAgentTaskRunner';
import { budgetPolicyService } from '../../services/BudgetPolicyService';
import { budgetWorkerAdmission, countBudgetWorkers } from '../../services/BudgetWorkerAdmission';
import { DelegatedWakeRepairNotice } from '../../services/DelegatedWakeRepairNotice';
import { workerModelRouting, installWorkerRoute } from '../../services/WorkerModelRouting';
import { RunActivity, watchForDeadRun } from '../../services/RunActivity';
import { JobLineageRootChatThreadFinder, TabVisibilityResolver, type TabVisibilityDecision } from '../../services/TabVisibilityResolver';
import { resolveAgentIdentity } from '../../utils/agentIdentity';

import { effectiveAgentRunLocation } from '@pkg/backend/sullaRuntime/state';

import type { AgentJobResult, AgentJobTask, AgentJobVisibility } from './jobRegistry';
import type { ResultReference } from '../../../shared/agentResults/AgentResultCard';
import type { WorkerModelRoute } from '../../languagemodels/workerModelBindings';
import type { ModelDecision } from '../../languagemodels/modelPrecedence';
import type { RoutableAgent } from '../../services/ChatAgentRouting';

export function childAbortForJob(asyncJob: boolean, parentAbort: any, taskAbortSignal?: AbortSignal) {
  return asyncJob ? combineAborts(undefined, taskAbortSignal) : combineAborts(parentAbort, taskAbortSignal);
}

// No open-tab cap: how many children run at once is steered by agent prompts,
// never blocked in code (Jonathon, 2026-10-11). Nesting depth IS capped — see
// MAX_SUBAGENT_DEPTH in jobRegistry (Jonathon, 2026-11-02).
const MAX_TASKS = 10;

async function trackingService() { return (await import('./link_result')).resultTrackingService() }

const CONTRACT_REMINDER = '[Return contract reminder]\nYou ended your turn without returning your contract. ' +
  'Call `agents/return_result` now with a result that matches the contract in your brief. ' +
  'If you cannot finish, return what you have and say why.';

interface SpawnTask {
  followUpOf?:    ResultReference;
  agentId?:   string;
  model?: string;
  effort?:        string;
  provider?: string;
  runLocation?: 'vm' | 'container';
  /** Alias for agentId — the database-backed custom agent slug.
   *  Accepted because callers routinely reach for "agentName"; resolved to the
   *  same selector so a natural-but-wrong key no longer silently no-ops. */
  agentName?: string;
  prompt:     string;
  label?:     string;
  /** Optional legacy task correlation id. */
  projectTaskId?: string;
  /** Existing worktree to clone into the container job's retained workspace. */
  workspacePath?: string;
  /** What the child must return. Omit for the default {status, summary, output}. */
  contract?:   unknown;
  /** 'hidden' (default) runs in the background; 'tab' opens a live chat tab. */
  visibility?: AgentJobVisibility;
  /** Tab only: focus the new tab. */
  focus?:      boolean;
  /** Internal launch metadata populated during validation. */
  modelDecision?: ModelDecision;
  modelOverride?: { provider: string; model: string; connections?: Record<string, string> };
}

interface LaunchedTab {
  jobId:         string;
  contractId:    string;
  childThreadId: string;
  agentId:       string;
  title:         string;
  status:        string;
  deduplicated?: boolean;
}

/** Projects tasks the calling graph already owns (its parent job). */


/** The agent-config selector for a task: agentId, or its agentName alias. */
function taskAgentSelector(task: SpawnTask): string | undefined {
  const sel = task.agentId || task.agentName;
  return typeof sel === 'string' && sel.trim() ? sel.trim() : undefined;
}

/** The agent graph a hidden task actually runs as; its worker mapping must belong to the same identity. */
export function taskGraphAgentChannel(task: Pick<SpawnTask, 'agentId' | 'agentName' | 'model'>, parentChannel: string): string {
  return taskAgentSelector(task as SpawnTask) || (typeof task.model === 'string' && task.model.trim() ? 'sulla-desktop' : parentChannel);
}

/** Per-task outcome of the visibility decision: what was asked and what actually runs. */
interface TabPlan {
  decision: TabVisibilityDecision;
  /** The agent a visible tab would open with (only set for a tab decision). */
  routable?: RoutableAgent;
}

// Every agent-launched sub-agent runs hidden unless the worker's
// `allowVisibleTabs` is set in code (never from the model's tool input). A
// requested "tab" that can't open is downgraded by TabVisibilityResolver, and
// the downgrade is recorded on the response and the task, never silent.
export class SpawnAgentWorker extends BaseTool {
  private readonly workerRoutes = new WeakMap<SpawnTask, WorkerModelRoute>();
  private readonly modelDecisions = new WeakMap<SpawnTask, ModelDecision>();
  private readonly modelOverrides = new WeakMap<SpawnTask, { provider: string; model: string; connections?: Record<string, string> }>();
  name = '';
  description = '';

  /** Code-only switch for visible tabs. Agents can't set it: tool input never reaches it. */
  allowVisibleTabs = false;

  constructor(
    private readonly turnPreparer = new DelegatedTurnPreparer(),
    private readonly tabVisibility = new TabVisibilityResolver(new JobLineageRootChatThreadFinder(findTaskByThread)),
  ) {
    super();
  }

  private assertDeduplicatedEffort(tasks: SpawnTask[], existing: AgentJobTask[]): void {
    tasks.forEach((task, index) => {
      if (task.effort !== undefined && (existing[index]?.effort !== task.effort || existing[index]?.model !== task.model?.trim())) {
        throw new Error('An existing job with this label has a different model or effort. Use a new task label to request a new run.');
      }
    });
  }

  private response(payload: Record<string, unknown>, successBoolean = true): ToolResponse {
    return { successBoolean, responseString: JSON.stringify(payload, null, 2), result: payload };
  }

  /** Reuse the canonical spawn path from compatibility wrappers. */
  public runValidated(input: any, state?: any): Promise<ToolResponse> {
    if (state) this.setState(state);

    return this._validatedCall(input);
  }

  /** Delegation-log row for one task of this call (outcome log for routing). */
  private delegationFor(task: SpawnTask, extra: Partial<AgentDelegationStart> = {}): AgentDelegationStart {
    const metadata = this.state?.metadata;
    const parentChannel = metadata?.wsChannel || 'sulla-desktop';
    return {
      via:            'spawn_agent',
      parentAgentId:  resolveAgentIdentity(metadata) || parentChannel,
      parentThreadId: metadata?.threadId ?? null,
      childAgentId:   taskAgentSelector(task) || parentChannel,
      taskId:         delegationTaskId(task.projectTaskId, metadata),
      situation:      delegationSituation(this.state?.messages),
      brief:          typeof task.prompt === 'string' ? task.prompt : '',
      ...extra,
    };
  }

  private async rejectTasks(tasks: SpawnTask[], reason: string): Promise<void> {
    await Promise.all(tasks.map(task => safeRejectDelegation(this.delegationFor(task), reason)));
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    // ── Validate tasks ──────────────────────────────────────────
    const tasks: SpawnTask[] = input.tasks;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return {
        successBoolean: false,
        responseString: 'tasks is required and must be a non-empty array of { prompt, agentId?, label?, contract?, visibility? } objects.',
      };
    }

    const { agentLaunchPauseService } = await import('../../services/AgentLaunchPauseService');
    if (await agentLaunchPauseService.isPaused()) {
      await this.rejectTasks(tasks, 'Jonathon has paused all agent launches from Live Agents');
      return { successBoolean: false, responseString: 'Jonathon has paused all agent launches from Live Agents' };
    }

    if (tasks.length > MAX_TASKS) {
      return {
        successBoolean: false,
        responseString: `Too many tasks (${ tasks.length }). Maximum is ${ MAX_TASKS } per call.`,
      };
    }

    const parentChannel = (this.state)?.metadata?.wsChannel || 'sulla-desktop';
    // The orchestrator's own conversation thread. Jobs use this to wake the
    // parent graph with their results when they finish, so an orchestrator
    // that fired-and-forgot doesn't sit thinking its sub-agents "died".
    const parentThreadId: string | undefined = (this.state as any)?.metadata?.threadId;
    const plans: TabPlan[] = [];
    const callerIsHiddenJob = Number((this.state as any)?.metadata?.subAgentDepth ?? 0) > 0;

    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].followUpOf !== undefined) {
        try { await (await trackingService()).validateFollowUp(tasks[i].followUpOf!, parentThreadId ?? '') } catch (error) { return { successBoolean: false, responseString: (error as Error).message } }
      }
      if (!tasks[i].prompt || typeof tasks[i].prompt !== 'string') {
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } is missing a "prompt" string.`,
        };
      }

      for (const key of ['model', 'provider'] as const) {
        if (tasks[i][key] !== undefined && (typeof tasks[i][key] !== 'string' || !tasks[i][key]!.trim())) {
          return { successBoolean: false, responseString: `Task ${ i }: ${ key } must be a non-empty string.` };
        }
      }
      if (tasks[i].runLocation !== undefined && !['vm', 'container'].includes(tasks[i].runLocation!)) {
        return { successBoolean: false, responseString: `Task ${ i }: runLocation must be vm or container.` };
      }
      try {
        const hasOverride = Boolean(tasks[i].model?.trim() || tasks[i].provider?.trim());
        // An explicit launch choice is a hard boundary: never read or attach a worker mapping.
        const workerRoute = hasOverride ? undefined : await workerModelRouting.newRoute(taskGraphAgentChannel(tasks[i], parentChannel));
        if (workerRoute) this.workerRoutes.set(tasks[i], workerRoute);
        const selector = taskAgentSelector(tasks[i]) || parentChannel;
        const currentDefinition = selector ? await agentDefinitionService.findBySlug(selector) : null;
        const { resolveLaunchModelPrecedence } = await import('../../languagemodels/modelPrecedence');
        const precedence = resolveLaunchModelPrecedence({
          override: { provider: tasks[i].provider, model: tasks[i].model, effort: tasks[i].effort },
          workerModelRoute: workerRoute,
          agentChoice: currentDefinition?.model_choice,
        });
        const modelDecision: ModelDecision = {
          requested: precedence.requested,
          ran: null,
          step: precedence.step,
          ...(precedence.reason ? { reason: precedence.reason } : {}),
        };
        if (tasks[i].effort !== undefined && workerRoute && precedence.step === 'agent-mapping') {
          modelDecision.reason = 'Per-run effort was ignored because the saved agent mapping takes precedence.';
        }
        if (precedence.step === 'override') {
          const { modelRouter } = await import('../../languagemodels/modelRouter');
          const requested = precedence.requested!;
          try { await modelRouter.resolve('agents', precedence.choice); } catch {
            throw new Error(`Requested model ${ requested.provider }/${ requested.model } is not available (not connected or unknown); refusing to run a different model.`);
          }
          tasks[i].provider = requested.provider;
          tasks[i].model = requested.model;
          const modelOverride: { provider: string; model: string; connections?: Record<string, string> } = { provider: requested.provider, model: requested.model };
          if (requested.provider === 'grok') modelOverride.connections = await workerModelRouting.subscriptionConnections([{ provider: requested.provider, model: requested.model }]);
          this.modelOverrides.set(tasks[i], modelOverride);
        } else if (tasks[i].effort !== undefined && !workerRoute) {
          const { effectiveModelChoice } = await import('../../languagemodels/threadModelChoice');
          const { modelRouter } = await import('../../languagemodels/modelRouter');
          await modelRouter.resolve('agents', effectiveModelChoice({ effort: tasks[i].effort }));
        }
        this.modelDecisions.set(tasks[i], modelDecision);
      } catch (error) {
        return { successBoolean: false, responseString: `Task ${ i }: ${ (error as Error).message }` };
      }
      const projectTaskId = tasks[i].projectTaskId;
      if (projectTaskId !== undefined && (typeof projectTaskId !== 'string' || !projectTaskId.trim())) {
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } has an invalid projectTaskId; pass a correlation id string or omit it.`,
        };
      }

      const visibility = tasks[i].visibility;
      if (visibility !== undefined && visibility !== 'hidden' && visibility !== 'tab') {
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } has visibility "${ String(visibility) }"; use "hidden" (default) or "tab".`,
        };
      }

      try {
        assertContractSchema(normalizeContract(tasks[i].contract));
      } catch (err) {
        await this.rejectTasks([tasks[i]], (err as Error).message);
        return { successBoolean: false, responseString: `Task at index ${ i }: ${ (err as Error).message }` };
      }

      // Fail fast on an unresolvable agent selector. Without this the task
      // silently fell back to the PARENT persona on the subconscious model
      // (e.g. a caller passing the wrong key ran a generic sub-agent on the
      // fallback provider instead of the intended worker) — a costly no-op
      // with no signal. A missing selector is still fine for hidden tasks.
      const selector = taskAgentSelector(tasks[i]);
      const routable = visibility === 'tab' ? await this.routableTabAgent(tasks[i]) : undefined;
      const decision = await this.tabVisibility.resolve({
        requested:         visibility,
        parentThreadId,
        callerIsHiddenJob,
        agentRoutable:     routable !== undefined,
        tabLaunchEnabled:  this.allowVisibleTabs,
        callerThreadId:    parentThreadId,
      });
      plans.push({ decision, routable });

      // A downgraded tab runs hidden, so it still needs a real agent selector.
      if (decision.visibility === 'hidden' && selector && !await agentDefinitionService.findBySlug(selector)) {
        await this.rejectTasks([tasks[i]], `unknown agent "${ selector }"`);
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } references agent "${ selector }" but no enabled agent definition exists. Use a valid agentId (or omit it to use the default agent).`,
        };
      }
    }

    // ── Depth ───────────────────────────────────────────────────
    // Hidden children carry it in metadata; a tab child runs as a normal
    // chat, so its depth is read from the job that owns its thread — that
    // registry read is also why a tab can't dodge the cap by omitting it.
    const parentDepth = await resolveAgentDepth((this.state)?.metadata?.subAgentDepth, parentThreadId);
    if (parentDepth >= MAX_SUBAGENT_DEPTH) {
      await this.rejectTasks(tasks, `max sub-agent depth ${ MAX_SUBAGENT_DEPTH } reached`);
      return {
        successBoolean: false,
        responseString: `max sub-agent depth ${ MAX_SUBAGENT_DEPTH } reached; do this yourself or return to your parent.`,
      };
    }

    const tabIndexes = tasks.map((_, index) => index).filter(index => plans[index].decision.visibility === 'tab');
    const hiddenIndexes = tasks.map((_, index) => index).filter(index => plans[index].decision.visibility === 'hidden');
    const hiddenTasks = hiddenIndexes.map(index => tasks[index]);
    const hiddenDecisions = hiddenIndexes.map(index => plans[index].decision);
    const decisions = plans.map(plan => plan.decision);

    // ── Tabs first: each is its own job, launched one at a time ──
    const tabs: LaunchedTab[] = [];
    for (const index of tabIndexes) {
      try {
        tabs.push(await this.launchTab(tasks[index], plans[index].routable!, parentDepth, plans[index].decision));
      } catch (err) {
        const opened = tabs.length ? ` Already opened: ${ tabs.map(tab => `${ tab.title } (${ tab.jobId })`).join(', ') }.` : '';
        return { successBoolean: false, responseString: `Tab launch for task ${ index } failed: ${ (err as Error).message }.${ opened }` };
      }
    }

    if (hiddenTasks.length === 0) {
      const policy = await budgetPolicyService.read();
      const liveJobs = await getAllJobs();
      const running = countBudgetWorkers(liveJobs);
      return this.withTaskVisibility(this.response({
          mode:          'tab',
          jobId:         tabs[0].jobId,
          contractId:    tabs[0].contractId,
          childThreadId: tabs[0].childThreadId,
          tabs,
          budget: { allowance: policy?.machine?.max_concurrent_workers ?? null, running, queued: budgetWorkerAdmission.queued, providerPace: null },
          message:       `${ tabs.length } agent tab(s) opened. Each stays open until its agent returns its contract; the result wakes this graph. Your <subagent_directory> shows their progress every turn.`,
      }), decisions);
    }

    const hidden = await this.launchHidden(hiddenTasks, input, parentDepth, hiddenDecisions);
    if (tabs.length === 0 || !hidden.successBoolean) return this.withTaskVisibility(hidden, decisions);
    return this.withTaskVisibility(this.response({ ...(hidden.result as Record<string, unknown>), tabs }, hidden.successBoolean), decisions);
  }

  /** The agent a visible tab would open with, or undefined when it isn't routable. */
  private async routableTabAgent(task: SpawnTask): Promise<RoutableAgent | undefined> {
    const metadata = (this.state as any)?.metadata;
    const parentChannel = metadata?.wsChannel || 'sulla-desktop';
    const { resolveRoutableAgent } = await import('../../services/ChatAgentRouting');
    // Preserve inherited persona unless a model-only launch explicitly asks
    // for the built-in Sulla persona with that override.
    const inheritedSelector = metadata?.routedAgentSourceId || metadata?.agentId || parentChannel;
    return (await resolveRoutableAgent(taskAgentSelector(task) || (task.model ? 'sulla' : inheritedSelector))) ?? undefined;
  }

  /** Adds each task's requested visibility and downgrade reason to the response (never silent). */
  private withTaskVisibility(response: ToolResponse, decisions: TabVisibilityDecision[]): ToolResponse {
    if (!response.result || typeof response.result !== 'object') return response;
    const result = {
      ...(response.result as Record<string, unknown>),
      taskVisibility: decisions.map((decision, index) => ({
        index,
        visibility: decision.visibility,
        ...(decision.requestedVisibility ? { requestedVisibility: decision.requestedVisibility } : {}),
        ...(decision.downgradeReason ? { downgradeReason: decision.downgradeReason } : {}),
      })),
    };
    return { ...response, result, responseString: JSON.stringify(result, null, 2) };
  }

  /**
   * One visible child: its own job (one task), its contract, a live chat tab.
   * The job stays running across turns; return_result or a stop closes it.
   * A decision that names a tabParentThreadId opens the tab under that thread
   * (the root human chat, when the caller is a hidden child).
   */
  private async launchTab(task: SpawnTask, childAgent: RoutableAgent, parentDepth: number, decision: TabVisibilityDecision): Promise<LaunchedTab> {
    const { resolveLaunchModelPrecedence } = await import('../../languagemodels/modelPrecedence');
    const launchPrecedence = resolveLaunchModelPrecedence({
      override: { provider: task.provider, model: task.model, effort: task.effort },
      workerModelRoute: this.workerRoutes.get(task),
    });
    const workerRoute = launchPrecedence.workerModelRoute;
    const modelDecision = this.modelDecisions.get(task);
    const modelOverride = this.modelOverrides.get(task);
    const { captureProviderCliSnapshot } = await import('../../../backend/providerCliUpdates');
    const providerCliSnapshot = await captureProviderCliSnapshot();
    const metadata = (this.state as any)?.metadata;
    const parentChannel = metadata?.wsChannel || 'sulla-desktop';
    const parentThreadId: string = decision.tabParentThreadId ?? metadata?.threadId;
    const parentAgentId = String(metadata?.routedAgentId ?? resolveAgentIdentity(metadata) ?? parentChannel).trim() || parentChannel;
    const contract = normalizeContract(task.contract);
    const depth = parentDepth + 1;
    const title = task.label?.trim() || childAgent.name;

    const [{ nextThreadId }, { resolveRoutableAgent, SULLA_DESKTOP_CHANNEL_ID }, { openAgentTab, stopAgentTab }] = await Promise.all([
      import('../../services/GraphRegistry'),
      import('../../services/ChatAgentRouting'),
      import('../../services/AgentTabOpener'),
    ]);
    const proposedChildThreadId = nextThreadId();
    const parentName = (await resolveRoutableAgent(parentAgentId))?.name ?? parentAgentId;

    const job = await createJob([{
      agentId:    childAgent.graphAgentId,
      label:      title,
      followUpOf:       task.followUpOf,
      provider: task.provider, model: task.model, effort:           task.effort,
      workerModelRoute: workerRoute,
      modelDecision,
      modelOverride,
      providerCliSnapshot,
      prompt:     task.prompt,
      taskId:     task.projectTaskId?.trim(),
      status:     'running',
      threadId:   proposedChildThreadId,
      startedAt:        Date.now(),
      visibility: 'tab',
      ...(decision.requestedVisibility ? { requestedVisibility: decision.requestedVisibility } : {}),
      contract,
      depth,
    }], parentChannel, parentThreadId, {
      visibility: 'tab', parentAgentId,
      dedupeLabel: task.label?.trim() || undefined,
    });

    const childThreadId = job.tasks[0]?.threadId || proposedChildThreadId;
    if (job.deduplicated) {
      this.assertDeduplicatedEffort([task], job.tasks);
      if (task.followUpOf) await (await trackingService()).link({ jobId: job.jobId, taskIndex: 0 }, { followUpOf: task.followUpOf }, parentThreadId);
      return {
        jobId: job.jobId, contractId: job.jobId, childThreadId,
        agentId: job.tasks[0]?.agentId || childAgent.graphAgentId,
        title: job.tasks[0]?.label || title, status: job.status, deduplicated: true,
      };
    }

    const delegationId = await safeStartDelegation(this.delegationFor(task, { via: 'agent_tab', childThreadId, refId: job.jobId }));

    // A tab waiting on its human is idle, not dead: only a turn in flight that
    // has gone silent counts as a dead run.
    const stopWatch = watchForDeadRun(job.jobId, async(reason, kind) => {
      const label = kind === 'tool_hung' ? 'hung tool' : 'dead run';
      if (abortJob(job.jobId, StopPrincipal.system('SpawnAgentDeadRunWatcher'), `${ label }: ${ reason }`) !== 'stopped') return;
      releaseJobWatcher(job.jobId);
      const message = `${ label }: ${ reason }; tab job stopped`;
      console.warn(`[spawn_agent] Tab job ${ job.jobId } ${ message }`);
      await stopAgentTab(childThreadId, `No agent activity while working (${ reason }). The parent was told and can relaunch.`);
      await safeFinishDelegationByRef(job.jobId, { outcome: 'failed', detail: message });
      await deliverJobCompletion(job, [], -1, message);
    }, async() => {
      const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
      return !getBackendGraphWebSocketService().hasActiveRun(SULLA_DESKTOP_CHANNEL_ID, childThreadId);
    }, { createdAt: job.createdAt, hasCheckin: async() => Object.values(await AgentJobMessagingModel.telemetryForJob(job.jobId)).some(item => item.latestCheckin !== null) });
    registerJobWatcher(job.jobId, stopWatch);

    try {
      await openAgentTab({
        jobId:           job.jobId,
        childThreadId,
        childAgent,
        title,
        parentThreadId,
        parentAgentId,
        parentAgentName:  parentName,
        depth,
        focus:            task.focus === true,
        prompt:           `[Agent tab launched by ${ parentName }]\n\n${ task.prompt }\n\n${ contractFooter({ jobId: job.jobId, contract, visibility: 'tab' }) }`,
        activityKeys:     RunActivity.inherit(metadata, job.jobId, `${ job.jobId }#0`),
        workerModelRoute: workerRoute,
        modelDecision,
        modelOverride,
        providerCliSnapshot,
        runOverrides: { model: task.model, provider: task.provider, effort: task.effort, runLocation: task.runLocation },
      });
    } catch (err) {
      releaseJobWatcher(job.jobId);
      failJob(job.jobId, (err as Error).message);
      await safeFinishDelegation(delegationId, { outcome: 'failed', detail: `error: ${ (err as Error).message }` });
      throw err;
    }

    await emitSubAgentExchange(parentChannel, parentThreadId, {
      direction:      'to_agent',
      agentId:        childAgent.graphAgentId,
      label:          title,
      summary:        `Opened ${ title } in a tab`,
      detail:         task.prompt,
      status:         'running',
      jobId:          job.jobId,
      taskIndex:      0,
      conversationId: childThreadId,
    });

    return { jobId: job.jobId, contractId: job.jobId, childThreadId, agentId: childAgent.graphAgentId, title, status: job.status };
  }

  /** Background children: one job for the batch, each child a full graph run. */
  private async launchHidden(tasks: SpawnTask[], input: any, parentDepth: number, decisions: TabVisibilityDecision[]): Promise<ToolResponse> {
    // ── Options ───────────────────────────────────────────────────
    const parallel: boolean = input.parallel !== false; // default true
    const async_: boolean = input.async !== false;       // default true

    // ── Lazy imports (keep out of renderer bundle) ──────────────
    const { GraphRegistry } = await import('../../services/GraphRegistry');
    const { captureProviderCliSnapshot } = await import('../../../backend/providerCliUpdates');
    const providerCliSnapshot = await captureProviderCliSnapshot();

    const parentChannel = (this.state)?.metadata?.wsChannel || 'sulla-desktop';
    const parentThreadId: string | undefined = (this.state as any)?.metadata?.threadId;
    const parentAgentId = resolveAgentIdentity((this.state as any)?.metadata) || undefined;
    const contracts: AgentContractSpec[] = tasks.map(task => normalizeContract(task.contract));
    const jobTasks: AgentJobTask[] = tasks.map((task, index) => {
      const agentId = taskAgentSelector(task) || parentChannel;
      return {
        agentId,
        label:      task.label || agentId || `task-${ index }`,
        prompt:           task.prompt,
        workerModelRoute: this.workerRoutes.get(task),
        modelDecision: this.modelDecisions.get(task),
        modelOverride: this.modelOverrides.get(task),
        providerCliSnapshot,
        provider:         task.provider?.trim() || undefined,
        model:      task.model?.trim() || undefined,
        ...(task.effort !== undefined ? { effort: task.effort } : {}),
        runLocation: task.runLocation,
        workspacePath: task.workspacePath,
        taskId:           task.projectTaskId?.trim(),
        followUpOf:       task.followUpOf,
        status:     'queued',
        visibility: 'hidden',
        ...(decisions[index]?.requestedVisibility ? { requestedVisibility: decisions[index].requestedVisibility, downgradeReason: decisions[index].downgradeReason } : {}),
        contract:   contracts[index],
        depth:      parentDepth + 1,
      };
    });
    const jobOptions = {
      visibility:  'hidden' as const,
      parentAgentId,
      // Dedupe is intentionally per single-task call; multi-task batches are
      // never partially reused. An omitted label opts out completely.
      dedupeLabel: tasks.length === 1 ? tasks[0].label?.trim() : undefined,
    };

    // Abort signal for THIS job (set once the job is created below).
    // Threaded into each sub-agent so stop_agent_job(jobId) can cancel them.
    const taskAbortSignals: AbortSignal[] = [];
    // Set once a job exists; its id is the dead-run activity key for the job.
    let activityJobId: string | undefined;
    // Delegation-log row per task index, so delivery can be recorded later.
    const delegationIds: (string | null)[] = [];

    // ── Single task executor ────────────────────────────────────
    const executePersistedTask = async(input: { task: AgentJobTask; taskIndex: number; threadId: string; generation: number }): Promise<AgentJobResult> => {
      const task: SpawnTask = { ...input.task, agentId: input.task.agentId, projectTaskId: input.task.taskId };
      const index = input.taskIndex;
      const threadId = input.threadId;
      const selector = taskAgentSelector(task);
      const label = task.label || selector || `task-${ index }`;
      const agentConfigChannel = taskGraphAgentChannel(task, parentChannel);
      const contract = contracts[index];
      const taskAbortSignal = taskAbortSignals[index];
      const delegationId = await safeStartDelegation(this.delegationFor(task, { childThreadId: threadId, refId: activityJobId ?? null }));
      delegationIds[index] = delegationId;

      if (activityJobId) {
        await updateJobTask(activityJobId, index, { status: 'running', threadId, startedAt: Date.now() });
        await emitSubAgentExchange(parentChannel, parentThreadId, {
          direction: 'to_agent',
          agentId: selector || parentChannel,
          label,
          summary: `Started ${ label }`,
          detail: task.prompt,
          status: 'running',
          jobId: activityJobId,
          taskIndex: index,
          conversationId: threadId,
        });
      }

      let subStateRef: any;
      let containerLifecycle: ParkedContainerLifecycle | undefined;
      let taskResult: AgentJobResult | undefined;
      const returnedTask = async() => {
        if (!activityJobId) return undefined;
        const settled = (await getJob(activityJobId))?.tasks[index];
        return settled?.returnedAt ? settled : undefined;
      };
      const cancelScheduledWait = () => {
        if (activityJobId) void agentWaitProvider.cancel(activityJobId, index).catch(() => {});
      };
      const runGraph = async(graph: any, subState: any): Promise<AgentJobResult> => {
        subStateRef = subState;
        installWorkerRoute(subState, input.task.workerModelRoute, activityJobId ? { jobId: activityJobId, taskIndex: index, generation: input.generation } : undefined);
        subState.metadata.modelDecision = input.task.modelDecision;
        if (input.task.modelOverride) subState.metadata.modelOverride = input.task.modelOverride;
        else delete subState.metadata.modelOverride;
        if (activityJobId) subState.metadata.modelDecisionTask = { jobId: activityJobId, taskIndex: index, generation: input.generation ?? 1, threadId };
        else delete subState.metadata.modelDecisionTask;
        if (input.task.providerCliSnapshot) subState.metadata.providerCliSnapshot = input.task.providerCliSnapshot;
        // Cached/saved thread metadata may predate a run-location migration.
        // The current agent row is canonical; an explicit task override below
        // remains the only way for a caller to change one run.
        const currentDefinition = selector ? await agentDefinitionService.findBySlug(selector) : null;
        subState.metadata.agent = {
          ...(subState.metadata.agent ?? {}),
          ...(currentDefinition ? { runLocation: currentDefinition.run_location } : {}),
          ...(task.model ? { model: task.model.trim() } : {}),
          ...(task.provider ? { provider: task.provider.trim() } : {}),
          ...(task.effort !== undefined ? { effort: task.effort } : {}),
          ...(task.runLocation ? { runLocation: task.runLocation } : {}),
        };
        if (!input.task.workerModelRoute && (task.model || task.provider)) {
          const { resolveLaunchModelPrecedence } = await import('../../languagemodels/modelPrecedence');
          const { modelRouter } = await import('../../languagemodels/modelRouter');
          const precedence = resolveLaunchModelPrecedence({ override: { provider: task.provider, model: task.model, effort: task.effort } });
          const requested = precedence.requested!;
          await modelRouter.resolve('agents', precedence.choice).catch(() => {
            throw new Error(`Requested model ${ requested.provider }/${ requested.model } is not available (not connected or unknown); refusing to run a different model.`);
          });
        }

        // Inject the brief and its return contract.
        DeferredStallInput.appendActionable(subState, {
          role:    'user',
          content: activityJobId
            ? `${ task.prompt }\n\n${ contractFooter({ jobId: activityJobId, contract, visibility: 'hidden' }) }`
            : task.prompt,
        });

        // Mark as sub-agent. Spawned agents do real delegated work — primary
        // model chain, not the subconscious observer slot.
        subState.metadata.isSubAgent = true;
        subState.metadata.runtimeRunnerActive = true;
        subState.metadata.modelSlot = 'primary';
        subState.metadata.subAgentDepth = parentDepth + 1;
        subState.metadata.workflowParentChannel = parentChannel;
        subState.metadata.delegatedJobId = activityJobId;
        subState.metadata.delegatedTaskIndex = index;
        subState.metadata.managerAgentId = parentAgentId || parentChannel;
        subState.metadata.managerThreadId = parentThreadId;
        // While this runner drives the graph, a human typing into the thread
        // (after "Open in tab") steers it instead of starting a second run.
        subState.metadata.delegatedRunActive = true;
        // Activity flows up: anything this sub-agent does keeps its parent run
        // (and this job) alive for dead-run detection.
        subState.metadata.activityKeys = RunActivity.inherit(
          (this.state as any)?.metadata, ...(activityJobId ? [activityJobId, `${ activityJobId }#${ index }`] : []),
        );
        // Propagate abort so both the user's stop button (parent AbortService)
        // AND stop_agent_job(jobId) (this job's signal) reach the sub-agents.
        // options.abort is typed AbortService everywhere else (Graph / BaseNode /
        // throwIfAborted). The 2026-07-15 wiring treated it as AbortSignal and
        // called AbortSignal.any([AbortService, jobSignal]) — TypeError:
        // "signals[0] must be AbortSignal". Keep the contract: always write
        // an AbortService that fans out from whichever sources exist.
        const parentAbort = (this.state as any)?.metadata?.options?.abort;
        // Fire-and-forget children outlive a superseded parent turn. Their
        // durable job abort is fired by stop_agent_job and by an explicit
        // stop_run on the parent thread. Synchronous children remain coupled.
        const combined = childAbortForJob(async_, parentAbort, taskAbortSignal);
        taskAbortSignal?.addEventListener('abort', cancelScheduledWait, { once: true });

        if (combined) {
          subState.metadata.options ??= {};
          subState.metadata.options.abort = combined;
        }

        // Register this threadId on the parent so user-abort fans out to it
        const parentMeta = (this.state as any)?.metadata;
        if (parentMeta) {
          const active = (parentMeta.activeSubAgentThreadIds ??= []);
          if (!active.includes(threadId)) active.push(threadId);
        }

        const runLocation = effectiveAgentRunLocation(String(subState.metadata.agent?.runLocation ?? DEFAULT_AGENT_RUN_LOCATION));
        if (runLocation === 'container') {
          const { modelRouter } = await import('../../languagemodels/modelRouter');
          const { effectiveModelChoice } = await import('../../languagemodels/threadModelChoice');
          const choice = input.task.workerModelRoute ? undefined : effectiveModelChoice({ provider: subState.metadata.agent?.provider, model: subState.metadata.agent?.model, effort: subState.metadata.agent?.effort, metadata: subState.metadata, agentChoice: currentDefinition?.model_choice });
          const routed = (input.task.workerModelRoute ? await workerModelRouting.resolveRoute(subState.metadata.workerModelRoute, combined?.signal ?? taskAbortSignal) : await modelRouter.resolve('agents', choice))[0];
          const provider = String(routed?.provider || subState.metadata.agent?.provider || '').trim();
          if (!activityJobId) throw new Error('Container agents require a durable job identity');
          const promptMessage = subState.messages[subState.messages.length - 1];
          if (typeof promptMessage?.content === 'string') {
            promptMessage.content += '\n\n[Container workspace] Agent-local file, shell, and Git work runs in the bounded job workspace shown by pwd. The workspace survives container exit; the container itself is removed when this job ends.';
          }
          const { createAgentContainerLifecycle } = await import('../../services/AgentContainerLauncher');
          const { delegatedThreadPersistenceKey } = await import('../../services/DelegatedContainerKey');
          const createLifecycle = () => createAgentContainerLifecycle({
            jobId: activityJobId!,
            taskIndex: index,
            provider,
            model:          routed?.model || subState.metadata.agent?.model,
            providerCliSnapshot: input.task.providerCliSnapshot,
            workspacePath:  task.workspacePath,
            state: subState,
            signal: combined?.signal ?? taskAbortSignal,
            // A scheduled wait may exceed the container idle limit. Recreated
            // runtimes must resume the same workspace and provider home.
            persistenceKey: delegatedThreadPersistenceKey(threadId),
          });
          containerLifecycle = new ParkedContainerLifecycle(await createLifecycle(), createLifecycle);
        }

        // Execute and settle every delegated turn through one policy loop.
        // The loop is intentionally re-entered after every wake/reminder so a
        // worker can schedule any number of waits on the same thread.
        const executeGraph = async() => {
          if (agentExecutionReadiness.active) await agentExecutionReadiness.wait(combined?.signal ?? taskAbortSignal);
          const result = containerLifecycle ? await containerLifecycle.execute(() => graph.execute(subState)) : await graph.execute(subState);
          if ((agentExecutionReadiness.draining || subState.metadata.runtimeInterrupted) && !await returnedTask()) throw Object.assign(executionAbort(), { runtimeInterrupted: true });
          return result;
        };
        const failedManagerCompletionRerouter = new FailedManagerCompletionRerouter();
        const freshTurnRunner = new DelegatedFreshTurnRunner({
          jobId:                  activityJobId,
          taskIndex:              index,
          threadId,
          state:                  subState,
          signal:                 combined?.signal ?? taskAbortSignal,
          prepare:                state => this.turnPreparer.prepare(state),
          execute:                executeGraph,
          returnedTask,
          getJob,
          openChildren:           childThreadId => agentJobLifecycle.openChildren(childThreadId),
          pendingWait:            (jobId, taskIndex) => agentWaitProvider.repository.pending(jobId, taskIndex),
          updateJobTask,
          endWakeTurn:            (jobId, taskIndex) => agentJobLifecycle.endWakeTurn(jobId, taskIndex),
          waitForWake:            (wakeThreadId, signal, timeout) => agentJobLifecycle.waitForWake(wakeThreadId, signal, timeout),
          repairInput:            async() => {
            notifyAgentCompletionsReady(selector || parentChannel, threadId);
            for (const row of await AgentJobMessagingModel.pendingMessagesForThread(threadId)) {
              agentJobLifecycle.deliver(threadId, {
 role: 'user',
content: `[Message from orchestrator]\n${ row.message }`,
                metadata: { source: 'orchestrator_job_message', inputSource: 'system', jobMessageId: row.id, jobMessageThreadId: threadId },
});
            }
          },
          alertRoot: (deadline, stillMissing) => new DelegatedWakeRepairNotice(id => agentJobProvider.jobs.findByTaskThread(id), completionInboxStore)
            .send(activityJobId!, index, threadId, deadline, stillMissing),
          logWake: facts => agentJobProvider.failureLogger.wake({
 ...facts,
graphCache: agentJobLifecycle.liveState(threadId) === subState
? 'live_runner'
            : GraphRegistry.get(threadId)?.state === subState ? 'registry' : 'miss',
}),
          resume:                 (jobId, taskIndex) => agentJobLifecycle.resume(jobId, taskIndex),
          rerouteCompletions:     (manager, taskIndex, reason, entries) => failedManagerCompletionRerouter.route(manager, taskIndex, reason, entries),
          acknowledgeCompletions: entries => Promise.all(entries.map(entry =>
            markTaskCompletionDelivered(entry.jobId, entry.taskIndex))),
        });
        const runFreshTurn = (currentState: any) => freshTurnRunner.run(currentState);

        let finalState = await executeGraph();
        let returned = await returnedTask();
        let reminderSent = false;
        let autoParkCount = 0;
        const settlementPolicy = new DelegatedTurnSettlementPolicy();
        while (activityJobId && !(combined?.signal ?? taskAbortSignal)?.aborted) {
          const openChildren = await agentJobLifecycle.openChildren(threadId);
          const pendingWait = await agentWaitProvider.repository.pending(activityJobId, index);
          // A timer/message can claim the durable wait before this turn reaches
          // settlement. The task's parked state remains authoritative during
          // that race, so consume the queued wake instead of fabricating a
          // missing-contract failure.
          const taskStillParked = (await getJob(activityJobId))?.tasks[index]?.status === 'parked';
          const turnOutcome = extractAgentTurnOutcome(finalState, task.prompt);
          const settlement = settlementPolicy.decide({
            returned: Boolean(returned), openChildren, pendingWait: Boolean(pendingWait) || taskStillParked, reminderSent,
            autoParkCount, finalText: turnOutcome.text, schemaContract: Boolean(contract.schema),
          });
          if (settlement === 'terminal' || settlement === 'fail') break;

          if (settlement === 'remind') {
            DeferredStallInput.appendActionable(subState, { role: 'user', content: CONTRACT_REMINDER, metadata: { source: 'contract_reminder' } });
            reminderSent = true;
            const turn = await runFreshTurn(finalState);
            finalState = turn.finalState;
            returned = turn.returned;
            continue;
          }

          if (settlement === 'auto_park') {
            autoParkCount += 1;
            const reason = 'ended turn without returning; auto-parked';
            await agentWaitProvider.parking.park(activityJobId, index, AgentWaitRequest.create(300, reason));
            subState.metadata.delegatedRunActive = false;
            await containerLifecycle?.park();
            await agentJobLifecycle.waitForWake(threadId, combined?.signal ?? taskAbortSignal);
            if ((agentExecutionReadiness.draining || subState.metadata.runtimeInterrupted) && !await returnedTask()) throw Object.assign(executionAbort(), { runtimeInterrupted: true });
            if ((combined?.signal ?? taskAbortSignal)?.aborted) break;
            await agentJobLifecycle.resume(activityJobId, index);
            await agentWaitProvider.cancel(activityJobId, index);
            if (settlementPolicy.decide({ returned: false, openChildren: 0, pendingWait: false, reminderSent: true, autoParkCount, finalText: turnOutcome.text, schemaContract: Boolean(contract.schema) }) === 'fail') {
              finalState = { ...finalState, messages: [...(finalState.messages ?? []), { role: 'assistant', content: 'ended turn 3 times without returning' }] };
              break;
            }
            await containerLifecycle?.resume();
            subState.metadata.delegatedRunActive = true;
            DeferredStallInput.appendActionable(subState, { role: 'user', content: 'You ended your turn without return_result. Continue your task; call return_result when done or agents/wait to wait.', metadata: { source: 'auto_park_resume' } });
            const turn = await runFreshTurn(finalState);
            finalState = turn.finalState;
            returned = turn.returned;
            continue;
          }

          // Preserve F-1 exactly: child parking remains owned by
          // parkWhenWaiting(), including its own fresh open-child check.
          if (settlement === 'child_park' && !await agentJobLifecycle.parkWhenWaiting(activityJobId, index, threadId)) continue;
          subState.metadata.delegatedRunActive = false;
          if (settlement === 'wait_park') await containerLifecycle?.park();
          await agentJobLifecycle.waitForWake(threadId, combined?.signal ?? taskAbortSignal);
          if ((agentExecutionReadiness.draining || subState.metadata.runtimeInterrupted) && !await returnedTask()) throw Object.assign(executionAbort(), { runtimeInterrupted: true });
          if ((combined?.signal ?? taskAbortSignal)?.aborted) break;
          returned = await returnedTask();
          if (returned) continue;
          await agentJobLifecycle.resume(activityJobId, index);
          if (settlement === 'wait_park') await containerLifecycle?.resume();
          subState.metadata.delegatedRunActive = true;
          const turn = await runFreshTurn(finalState);
          finalState = turn.finalState;
          returned = turn.returned;
        }

        // The last consumer has decided. Close admission before terminal I/O;
        // teardown still owns the registration until persistence finishes.
        agentJobLifecycle.closeInput(threadId, subState);
        if (GraphRegistry.get(threadId)?.state === subState) GraphRegistry.delete(threadId);
        // Settlement and stop both invalidate any scheduled timer before
        // the task status changes, so a racing callback cannot wake it later.
        await agentWaitProvider.cancel(activityJobId!, index);
        taskAbortSignal?.removeEventListener('abort', cancelScheduledWait);

        const stoppedResult = activityJobId
          ? await stoppedTaskResult(activityJobId, index, label, threadId)
          : undefined;
        if (stoppedResult) {
          taskResult = stoppedResult;
        } else if (returned) {
          taskResult = returnedJobResult(returned, label, threadId);
        } else {
          // Canonical blocked-branch + output-fallback chain for spawned jobs.
          const { status, text } = extractAgentTurnOutcome(finalState, task.prompt);
          taskResult = (settlementPolicy.decide({ returned: false, openChildren: 0, pendingWait: false, reminderSent, autoParkCount, finalText: text, schemaContract: Boolean(contract.schema) }) === 'fail') && status !== 'blocked'
            ? { label, status: 'error', output: `failed: ${ new MissingContractAfterReminderError(settlementPolicy.failureCause(finalState)).message }`, threadId, contract: contract.name }
            : { label, status, output: text, threadId, contract: contract.name };
        }

        await safeFinishDelegation(delegationId, {
          outcome: taskResult.status === 'completed' ? 'completed' : 'failed',
          detail:  taskResult.status === 'completed' ? '' : `${ taskResult.status }: ${ taskResult.output }`,
        });
        if (activityJobId) {
          await updateJobTask(activityJobId, index, { status: taskResult.status, threadId, finishedAt: Date.now() });
          await emitSubAgentExchange(parentChannel, parentThreadId, {
            direction: 'from_agent',
            agentId: selector || parentChannel,
            label,
            summary: taskResult.status === 'completed' ? `${ label } finished` : `${ label } is ${ taskResult.status }`,
            detail: taskResult.output,
            status: taskResult.status === 'completed' ? 'done' : taskResult.status === 'stopped' ? 'stopped' : 'failed',
            jobId: activityJobId,
            taskIndex: index,
            conversationId: threadId,
          });
        }
        return taskResult;
      };
      try {
        const { graph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(
          agentConfigChannel,
          threadId,
        ) as { graph: any; state: any };
        return await agentJobLifecycle.withRunner(threadId, subState, () => runGraph(graph, subState));
      } catch (err) {
        // return_result is the completion commit point. A graph/provider error
        // racing after it must not overwrite the valid contract with failure.
        const returned = await returnedTask();

        if (returned) {
          taskResult = returnedJobResult(returned, label, threadId);
          await safeFinishDelegation(delegationId, { outcome: 'completed', detail: '' });
          if (activityJobId) {
            await updateJobTask(activityJobId, index, { status: taskResult.status, threadId, finishedAt: Date.now() });
          }
          return taskResult;
        }
        if (agentExecutionReadiness.draining || subStateRef?.metadata?.runtimeInterrupted) {
          // Leave the durable running/parked state for the existing recovery path.
          // Shutdown is not a failed task or a new completion.
          if (subStateRef) await saveThreadState(subStateRef);
          throw Object.assign(executionAbort(), { runtimeInterrupted: true });
        }
        const stoppedResult = activityJobId
          ? await stoppedTaskResult(activityJobId, index, label, threadId)
          : undefined;
        const output = stoppedResult?.output ?? `Error: ${ (err as Error).message }`;
        const stopped = Boolean(stoppedResult) || taskAbortSignal?.aborted === true;
        await safeFinishDelegation(delegationId, { outcome: 'failed', detail: `${ stopped ? 'stopped' : 'error' }: ${ output }` });
        if (activityJobId) {
          await updateJobTask(activityJobId, index, { status: stopped ? 'stopped' : 'error', threadId, finishedAt: Date.now() });
          await emitSubAgentExchange(parentChannel, parentThreadId, {
            direction: 'from_agent',
            agentId:        selector || parentChannel,
            label,
            summary: stopped ? `${ label } was stopped` : `${ label } failed`,
            detail: output,
            status: stopped ? 'stopped' : 'failed',
            jobId: activityJobId,
            taskIndex: index,
            conversationId: threadId,
          });
        }
        taskResult = stoppedResult ?? {
          label,
          status:   'error',
          output,
          threadId,
        };
        return taskResult;
      } finally {
        try {
          const cleanupReason = taskResult?.status === 'completed'
            ? 'delegated-job-completed'
            : 'delegated-job-finished';
          const cleanupReceipt = await containerLifecycle?.close(cleanupReason);
          if (taskResult && cleanupReceipt) {
            taskResult.cleanupReceipt = cleanupReceipt;
            if (cleanupReceipt.recoveryWorkspacePath) {
              taskResult.output += `\n\n[Container recovery] Guest workspace retained at ${ cleanupReceipt.recoveryWorkspacePath }. ${ cleanupReceipt.workspaceDecisionReason }`;
            }
          }
        } finally {
          taskAbortSignal?.removeEventListener('abort', cancelScheduledWait);
          if (activityJobId && !agentExecutionReadiness.draining && !subStateRef?.metadata?.runtimeInterrupted) await agentWaitProvider.cancel(activityJobId, index).catch(() => {});
          if (subStateRef?.metadata) {
            subStateRef.metadata.delegatedRunActive = false;
            subStateRef.metadata.runtimeRunnerActive = false;
          }
          notifyAgentCompletionsReady(selector || parentChannel, threadId);
          // Deregister from parent's active-sub-agents list so stale threadIds
          // don't receive abort signals after the subagent has already exited
          const parentMeta = (this.state as any)?.metadata;
          if (parentMeta?.activeSubAgentThreadIds) {
            const arr: string[] = parentMeta.activeSubAgentThreadIds;
            const idx = arr.indexOf(threadId);
            if (idx >= 0) arr.splice(idx, 1);
          }
          // Clean up registry to prevent memory leaks
          if (subStateRef && GraphRegistry.get(threadId)?.state === subStateRef) GraphRegistry.delete(threadId);
        }
      }
    };

    const taskRunner = new HiddenAgentTaskRunner({ execute: executePersistedTask });
    const executeSingle = (task: SpawnTask, index: number): Promise<AgentJobResult> => {
      const label = task.label || taskAgentSelector(task) || `task-${ index }`;
      const run = () => taskRunner.run({
        task: jobTasks[index],
        taskIndex: index,
        threadId:   `spawn-agent-${ threadSlug(label) }-${ Date.now() }-${ index }`,
        generation: jobTasks[index].generation ?? 1,
      });
      return budgetWorkerAdmission.run(async() => {
        const policy = await budgetPolicyService.read();
        const liveJobs = await getAllJobs();
        const liveRunning = countBudgetWorkers(liveJobs);
        return {
          allowance: policy?.machine?.max_concurrent_workers ?? null,
          // Running tasks held by this gate have reserved a slot but may not
          // yet have persisted status=running. Don't count them twice.
          running: Math.max(0, liveRunning - budgetWorkerAdmission.running),
        };
      }, run);
    };

    // ── Execute all tasks (parallel or sequential) ──────────────
    // Each task is committed and offered to the parent as soon as it settles.
    // The final job completion below is bookkeeping only; it never re-delivers.
    const settleTask = async(task: (typeof tasks)[number], index: number): Promise<AgentJobResult> => {
      let result: AgentJobResult;
      try {
        result = await executeSingle(task, index);
      } catch (reason) {
        if ((reason as any)?.runtimeInterrupted) throw reason;
        result = {
          label:    task.label || taskAgentSelector(task) || `task-${ index }`,
          status: 'error',
          output: `Unexpected error: ${ reason }`,
          threadId: '',
        };
      }

      if (activityJobId) {
        await recordTaskCompletion(activityJobId, index, result);
        const failureReason = result.status === 'error' ? result.output : undefined;
        const settledJob = await getJob(activityJobId);
        if (settledJob) await deliverJobCompletion(settledJob, [result], index, failureReason);
      }
      // Completion anywhere can release a slot for this FIFO queue.
      await budgetWorkerAdmission.slotMayHaveFreed();
      return result;
    };

    const executeAll = async(): Promise<AgentJobResult[]> => {
      if (tasks.length === 1 || !parallel) {
        const results: AgentJobResult[] = [];
        for (let i = 0; i < tasks.length; i++) results.push(await settleTask(tasks[i], i));
        return results;
      }
      const outcomes = await Promise.allSettled(tasks.map((task, index) => settleTask(task, index)));
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (rejected) throw rejected.reason;
      return outcomes.map(outcome => (outcome as PromiseFulfilledResult<AgentJobResult>).value);
    };

    // ── Async mode: fire and forget ─────────────────────────────
    if (async_) {
      const job = await createJob(jobTasks, parentChannel, parentThreadId, jobOptions);
      if (job.deduplicated) {
        this.assertDeduplicatedEffort(tasks, job.tasks);
        if (tasks[0].followUpOf) await (await trackingService()).link({ jobId: job.jobId, taskIndex: 0 }, { followUpOf: tasks[0].followUpOf }, parentThreadId ?? '');
        const response = {
          mode: 'async', jobId: job.jobId, taskCount: tasks.length, parallel,
          deduplicated: true,
          status: job.status,
          message: `A matching labeled spawn already exists with status "${ job.status }"; reused the existing job.`,
        };
        return this.response(response);
      }
      // Wire this job's abort signal in BEFORE launching, so a stop_agent_job
      // call fans out to every sub-agent this job spawns.
      activityJobId = job.jobId;
      for (let index = 0; index < tasks.length; index++) taskAbortSignals[index] = getTaskAbortSignal(job.jobId, index)!;

      // A job whose whole agent tree goes silent is dead: stop it (which hands
      // back any task it owns) and tell the parent, instead of waiting forever
      // on a provider call that will never return.
      let stoppedAsDead = false;
      const stopDeadRunWatch = watchForDeadRun(job.jobId, async(reason, kind) => {
        const label = kind === 'tool_hung' ? 'hung tool' : 'dead run';
        if (abortJob(job.jobId, StopPrincipal.system('SpawnAgentDeadRunWatcher'), `${ label }: ${ reason }`) !== 'stopped') return;
        stoppedAsDead = true;
        const message = `${ label }: ${ reason }; job stopped`;
        console.warn(`[spawn_agent] Async job ${ job.jobId } ${ message }`);
        const stoppedJob = await getJob(job.jobId);
        if (stoppedJob) await deliverJobCompletion(stoppedJob, [], -1, message);
      }, async() => false, { createdAt: job.createdAt, hasCheckin: async() => Object.values(await AgentJobMessagingModel.telemetryForJob(job.jobId)).some(item => item.latestCheckin !== null) });

      // Launch in background — do not await
      const backgroundRun = executeAll()
        .then(async(results) => {
          await completeJob(job.jobId, results);
          if (stoppedAsDead) return; // the parent was already told

          const failed = results.find(result => result.status === 'error');
          console.log(`[spawn_agent] Async job ${ job.jobId } ${ failed ? 'failed' : 'completed' } — ${ results.length } result(s), each delivered on settlement`);
        })
        .catch(async(err) => {
          if (err?.runtimeInterrupted || agentExecutionReadiness.draining) return;
          failJob(job.jobId, (err as Error).message);
          console.error(`[spawn_agent] Async job ${ job.jobId } failed:`, err);
          if (stoppedAsDead) return;
          const failedJob = await getJob(job.jobId);
          if (failedJob) await deliverJobCompletion(failedJob, [], -1, (err as Error).message);
        })
        .finally(async() => { stopDeadRunWatch(); });
      trackHiddenAgentRun(backgroundRun);

      const policy = await budgetPolicyService.read();
      const jobs = await getAllJobs();
      const running = jobs.filter(item => item.visibility !== 'tab').reduce((total, item) => total + item.tasks.filter(child => child.status === 'running').length, 0);
      const providerPaces = await Promise.all(tasks.map(async task => {
        const definition = taskAgentSelector(task) ? await agentDefinitionService.findBySlug(taskAgentSelector(task)!) : null;
        const provider = task.provider?.trim() || definition?.provider || undefined;
        return { provider, pace: provider ? policy?.providers?.[provider]?.pace ?? null : null, advice: provider ? policy?.providers?.[provider]?.advice : undefined };
      }));
      const warnings = [...new Set(providerPaces.filter(item => item.pace === 'hard-conserve').map(item =>
        `Budgeter warning: ${ item.provider } is hard-conserve. ${ item.advice ?? 'Avoid new work on this provider.' } Explicit provider/model requests are not rerouted.`,
      ))];
      const response = {
        mode:      'async',
        jobId:     job.jobId,
        taskCount: tasks.length,
        parallel,
        budget: { allowance: policy?.machine?.max_concurrent_workers ?? null, running, queued: budgetWorkerAdmission.queued, providerPace: providerPaces.length === 1 ? providerPaces[0].pace : providerPaces },
        ...(warnings.length ? { warning: warnings.join(' ') } : {}),
        message:   `${ tasks.length } sub-agent(s) launched in the background. Results will wake this graph when they finish (check_agent_jobs is the fallback/history read).`,
      };
      return this.response(response);
    }

    // ── Sync mode: block until complete ─────────────────────────
    // Sync launches need a durable job too: otherwise the rail and exchange
    // components would only exist for fire-and-forget work.
    const syncJob = await createJob(jobTasks, parentChannel, parentThreadId, jobOptions);
    if (syncJob.deduplicated) {
      this.assertDeduplicatedEffort(tasks, syncJob.tasks);
      if (tasks[0].followUpOf) await (await trackingService()).link({ jobId: syncJob.jobId, taskIndex: 0 }, { followUpOf: tasks[0].followUpOf }, parentThreadId ?? '');
      return this.response({
        mode: 'sync', jobId: syncJob.jobId, taskCount: syncJob.taskCount,
        parallel, deduplicated: true, status:       syncJob.status,
        message: `A matching labeled spawn already exists with status "${ syncJob.status }"; reused the existing job.`,
      });
    }
    let stopDeadRunWatch: (() => void) | undefined;
    const jobId = syncJob.jobId;
    activityJobId = jobId;
    for (let index = 0; index < tasks.length; index++) taskAbortSignals[index] = getTaskAbortSignal(jobId, index)!;
    // Stopping a dead job hands its tasks back even if the hung call never returns.
    stopDeadRunWatch = watchForDeadRun(jobId, (reason, kind) => {
      const label = kind === 'tool_hung' ? 'hung tool' : 'dead run';
      if (abortJob(jobId, StopPrincipal.system('SpawnAgentDeadRunWatcher'), `${ label }: ${ reason }`) === 'stopped') console.warn(`[spawn_agent] Sync job ${ jobId } ${ label }: ${ reason }; job stopped`);
    }, async() => false, { createdAt: syncJob.createdAt, hasCheckin: async() => Object.values(await AgentJobMessagingModel.telemetryForJob(jobId)).some(item => item.latestCheckin !== null) });
    let results: AgentJobResult[];
    try {
      results = await trackHiddenAgentRun(executeAll());
    } catch (err) {
      if ((err as any)?.runtimeInterrupted || agentExecutionReadiness.draining) throw executionAbort();
      failJob(syncJob.jobId, (err as Error).message);
      throw err;
    } finally {
      stopDeadRunWatch?.();
    }
    // The caller is reading the results right here; only the durable display /
    // ownership record needs settling, not a background wake.
    await completeJob(syncJob.jobId, results);
    await markCompletionDelivered(syncJob.jobId);
    await safeMarkDelegationsDelivered(delegationIds);

    const allSuccess = results.every(r => r.status === 'completed');
    const policy = await budgetPolicyService.read();
    const liveJobs = await getAllJobs();
    const running = countBudgetWorkers(liveJobs);
    const providerPaces = await Promise.all(tasks.map(async task => {
      const definition = taskAgentSelector(task) ? await agentDefinitionService.findBySlug(taskAgentSelector(task)!) : null;
      const provider = task.provider?.trim() || definition?.provider || undefined;
      return { provider, pace: provider ? policy?.providers?.[provider]?.pace ?? null : null };
    }));

    const formatted = results.map(r =>
      `### ${ r.label } [${ r.status.toUpperCase() }]\n${ r.output }`,
    ).join('\n\n---\n\n');

    return this.response({
      mode: 'sync', jobId: syncJob.jobId, taskCount: tasks.length, parallel,
      budget: { allowance: policy?.machine?.max_concurrent_workers ?? null, running, queued: budgetWorkerAdmission.queued, providerPace: providerPaces.length === 1 ? providerPaces[0].pace : providerPaces },
      results,
      message: tasks.length === 1
        ? results[0].output
        : `${ results.length } sub-agent(s) completed.\n\n${ formatted }`,
    }, allSuccess);
  }
}
