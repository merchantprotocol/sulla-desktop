import { BaseTool, ToolResponse } from '../base';
import { extractAgentTurnOutcome } from './agentTurnOutcome';
import {
  assertContractSchema,
  contractFooter,
  normalizeContract,
  type AgentContractSpec,
} from './contract';
import { emitProactiveCompletion, returnedJobResult, wakeParentGraph } from './jobDelivery';
import { emitSubAgentExchange } from './jobExchange';
import {
  abortJob,
  completeJob,
  createJob,
  delegationDepthForThread,
  deleteJob,
  failJob,
  getJob,
  getJobAbortSignal,
  markCompletionDelivered,
  registerJobWatcher,
  releaseJobWatcher,
  updateJobTask,
} from './jobRegistry';
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
import { combineAborts } from '../../services/AbortService';
import { agentDefinitionService } from '../../services/AgentDefinitionService';
import { RunActivity, watchForDeadRun } from '../../services/RunActivity';
import { resolveAgentIdentity } from '../../utils/agentIdentity';

import type { AgentJobResult, AgentJobTask, AgentJobVisibility } from './jobRegistry';
import type { RoutableAgent } from '../../services/ChatAgentRouting';

// No depth or open-tab caps: who may launch whom, and how many, is steered by
// agent prompts, never blocked in code (Jonathon, 2026-10-11).
const MAX_TASKS = 10;

const CONTRACT_REMINDER = '[Return contract reminder]\nYou ended your turn without returning your contract. ' +
  'Call `agents/return_result` now with a result that matches the contract in your brief. ' +
  'If you cannot finish, return what you have and say why.';

interface SpawnTask {
  agentId?:   string;
  /** Alias for agentId — the database-backed custom agent slug.
   *  Accepted because callers routinely reach for "agentName"; resolved to the
   *  same selector so a natural-but-wrong key no longer silently no-ops. */
  agentName?: string;
  prompt:     string;
  label?:     string;
  /** Projects task this sub-agent works. The job owns it for the whole run:
   *  assignee becomes the agent and no other writer may take the task. */
  projectTaskId?: string;
  /** What the child must return. Omit for the default {status, summary, output}. */
  contract?:   unknown;
  /** 'hidden' (default) runs in the background; 'tab' opens a live chat tab. */
  visibility?: AgentJobVisibility;
  /** Tab only: focus the new tab. */
  focus?:      boolean;
}

interface LaunchedTab {
  jobId:         string;
  contractId:    string;
  childThreadId: string;
  agentId:       string;
  title:         string;
}

/** Projects tasks the calling graph already owns (its parent job). */
function inheritedTaskIds(metadata: any): string[] {
  const owned = Array.isArray(metadata?.ownedProjectTaskIds) ? metadata.ownedProjectTaskIds : [];
  return owned.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
}

/** The agent-config selector for a task: agentId, or its agentName alias. */
function taskAgentSelector(task: SpawnTask): string | undefined {
  const sel = task.agentId || task.agentName;
  return typeof sel === 'string' && sel.trim() ? sel.trim() : undefined;
}

function taskVisibility(task: SpawnTask): AgentJobVisibility {
  return task.visibility === 'tab' ? 'tab' : 'hidden';
}

export class SpawnAgentWorker extends BaseTool {
  name = '';
  description = '';

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
      via:            taskVisibility(task) === 'tab' ? 'agent_tab' : 'spawn_agent',
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
    const tabAgents = new Map<number, RoutableAgent>();

    for (let i = 0; i < tasks.length; i++) {
      if (!tasks[i].prompt || typeof tasks[i].prompt !== 'string') {
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } is missing a "prompt" string.`,
        };
      }

      const projectTaskId = tasks[i].projectTaskId;
      if (projectTaskId !== undefined && (typeof projectTaskId !== 'string' || !projectTaskId.trim())) {
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } has an invalid projectTaskId; pass the Projects task id string (e.g. "AwBS") or omit it.`,
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
      if (visibility === 'tab') {
        if (!parentThreadId) {
          return { successBoolean: false, responseString: 'A tab launch must come from an active chat thread.' };
        }
        const { resolveRoutableAgent } = await import('../../services/ChatAgentRouting');
        const routable = selector ? await resolveRoutableAgent(selector) : null;
        if (!routable) {
          await this.rejectTasks([tasks[i]], `unknown agent "${ selector ?? '' }"`);
          return {
            successBoolean: false,
            responseString: `Task at index ${ i } is a tab launch, which needs an enabled agentId; "${ selector ?? '' }" does not exist, is disabled, or is archived.`,
          };
        }
        tabAgents.set(i, routable);
      } else if (selector && !await agentDefinitionService.findBySlug(selector)) {
        await this.rejectTasks([tasks[i]], `unknown agent "${ selector }"`);
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } references agent "${ selector }" but no enabled agent definition exists. Use a valid agentId (or omit it to use the default agent).`,
        };
      }
    }

    // ── Depth ───────────────────────────────────────────────────
    // Recorded on each child (rail, directory), not enforced. Hidden children
    // carry it in metadata; a tab child runs as a normal chat, so its depth is
    // read from the job that owns its thread.
    const parentDepth = Math.max(
      Number((this.state)?.metadata?.subAgentDepth) || 0,
      await delegationDepthForThread(parentThreadId),
    );

    const tabTasks = tasks.map((task, index) => ({ task, index })).filter(({ task }) => taskVisibility(task) === 'tab');
    const hiddenTasks = tasks.filter(task => taskVisibility(task) === 'hidden');

    // ── Tabs first: each is its own job, launched one at a time ──
    const tabs: LaunchedTab[] = [];
    for (const { task, index } of tabTasks) {
      try {
        tabs.push(await this.launchTab(task, tabAgents.get(index)!, parentDepth));
      } catch (err) {
        const opened = tabs.length ? ` Already opened: ${ tabs.map(tab => `${ tab.title } (${ tab.jobId })`).join(', ') }.` : '';
        return { successBoolean: false, responseString: `Tab launch for task ${ index } failed: ${ (err as Error).message }.${ opened }` };
      }
    }

    if (hiddenTasks.length === 0) {
      return {
        successBoolean: true,
        responseString: JSON.stringify({
          mode:          'tab',
          jobId:         tabs[0].jobId,
          contractId:    tabs[0].contractId,
          childThreadId: tabs[0].childThreadId,
          tabs,
          message:       `${ tabs.length } agent tab(s) opened. Each stays open until its agent returns its contract; the result wakes this graph. Your <subagent_directory> shows their progress every turn.`,
        }, null, 2),
      };
    }

    const hidden = await this.launchHidden(hiddenTasks, input, parentDepth);
    if (tabs.length === 0 || !hidden.successBoolean) return hidden;
    try {
      return { ...hidden, responseString: JSON.stringify({ ...JSON.parse(hidden.responseString), tabs }, null, 2) };
    } catch {
      return { ...hidden, responseString: `${ hidden.responseString }\n\nAgent tabs opened: ${ JSON.stringify(tabs) }` };
    }
  }

  /**
   * One visible child: its own job (one task), its contract, a live chat tab.
   * The job stays running across turns; return_result or a stop closes it.
   */
  private async launchTab(task: SpawnTask, childAgent: RoutableAgent, parentDepth: number): Promise<LaunchedTab> {
    const metadata = (this.state as any)?.metadata;
    const parentChannel = metadata?.wsChannel || 'sulla-desktop';
    const parentThreadId: string = metadata?.threadId;
    const parentAgentId = String(metadata?.routedAgentId ?? resolveAgentIdentity(metadata) ?? parentChannel).trim() || parentChannel;
    const contract = normalizeContract(task.contract);
    const depth = parentDepth + 1;
    const title = task.label?.trim() || childAgent.name;

    const [{ nextThreadId }, { resolveRoutableAgent, SULLA_DESKTOP_CHANNEL_ID }, { openAgentTab, stopAgentTab }] = await Promise.all([
      import('../../services/GraphRegistry'),
      import('../../services/ChatAgentRouting'),
      import('../../services/AgentTabOpener'),
    ]);
    const childThreadId = nextThreadId();
    const parentName = (await resolveRoutableAgent(parentAgentId))?.name ?? parentAgentId;

    const job = await createJob([{
      agentId:    childAgent.graphAgentId,
      label:      title,
      prompt:     task.prompt,
      taskId:     task.projectTaskId?.trim(),
      status:     'running',
      threadId:   childThreadId,
      startedAt:  Date.now(),
      visibility: 'tab',
      contract,
      depth,
    }], parentChannel, parentThreadId, { visibility: 'tab', parentAgentId });
    const { beginAgentScratch } = await import('../../files/scratchLifecycle');
    await beginAgentScratch(job.jobId, String(metadata?.userId ?? metadata?.ownerUserId ?? parentChannel), metadata?.orgId);

    // Ownership: a tab that works a Projects task holds it until it returns.
    const inherited = inheritedTaskIds(metadata);
    if (task.projectTaskId) {
      const { WorkTaskOwnershipModel } = await import('../../database/models/WorkTaskOwnershipModel');
      let refusal: string | undefined;
      try {
        const claim = await WorkTaskOwnershipModel.claimForJob(job.jobId, { [task.projectTaskId.trim()]: childAgent.graphAgentId }, inherited);
        if (!claim.claimed) {
          refusal = `Not launched: ${ claim.conflicts.map(owner => `task ${ owner.taskId } is owned by ${ owner.kind } ${ owner.ref }`).join('; ') }. ` +
            'Only one agent may work a task at a time.';
        }
      } catch (err) {
        refusal = `Not launched: could not take ownership of ${ task.projectTaskId } (${ (err as Error).message }).`;
      }
      if (refusal) {
        await this.rejectTasks([task], refusal);
        deleteJob(job.jobId);
        throw new Error(refusal);
      }
    }

    const delegationId = await safeStartDelegation(this.delegationFor(task, { childThreadId, refId: job.jobId }));

    // A tab waiting on its human is idle, not dead: only a turn in flight that
    // has gone silent counts as a dead run.
    const stopWatch = watchForDeadRun(job.jobId, async(reason) => {
      if (abortJob(job.jobId) !== 'stopped') return;
      releaseJobWatcher(job.jobId);
      const message = `dead run: ${ reason }; tab job stopped`;
      console.warn(`[spawn_agent] Tab job ${ job.jobId } ${ message }`);
      await stopAgentTab(childThreadId, `No agent activity while working (${ reason }). The parent was told and can relaunch.`);
      await safeFinishDelegationByRef(job.jobId, { outcome: 'failed', detail: message });
      await emitProactiveCompletion(parentChannel, job.jobId, [], message, parentThreadId);
      await wakeParentGraph(parentChannel, parentThreadId, job.jobId, [], message);
    }, async() => {
      const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
      return !getBackendGraphWebSocketService().hasActiveRun(SULLA_DESKTOP_CHANNEL_ID, childThreadId);
    });
    registerJobWatcher(job.jobId, stopWatch);

    try {
      await openAgentTab({
        jobId:           job.jobId,
        childThreadId,
        childAgent,
        title,
        parentThreadId,
        parentAgentId,
        parentAgentName: parentName,
        depth,
        focus:           task.focus === true,
        prompt:          `[Agent tab launched by ${ parentName }]\n\n${ task.prompt }\n\n${ contractFooter({ jobId: job.jobId, contract, visibility: 'tab' }) }`,
        activityKeys:    RunActivity.inherit(metadata, job.jobId),
        ownedProjectTaskIds: [...new Set([...inherited, ...(task.projectTaskId ? [task.projectTaskId.trim()] : [])])],
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

    return { jobId: job.jobId, contractId: job.jobId, childThreadId, agentId: childAgent.graphAgentId, title };
  }

  /** Background children: one job for the batch, each child a full graph run. */
  private async launchHidden(tasks: SpawnTask[], input: any, parentDepth: number): Promise<ToolResponse> {
    // ── Options ───────────────────────────────────────────────────
    const parallel: boolean = input.parallel !== false; // default true
    const async_: boolean = input.async !== false;       // default true

    // ── Lazy imports (keep out of renderer bundle) ──────────────
    const { GraphRegistry } = await import('../../services/GraphRegistry');

    const parentChannel = (this.state)?.metadata?.wsChannel || 'sulla-desktop';
    const parentThreadId: string | undefined = (this.state as any)?.metadata?.threadId;
    const parentAgentId = resolveAgentIdentity((this.state as any)?.metadata) || undefined;
    const contracts: AgentContractSpec[] = tasks.map(task => normalizeContract(task.contract));
    const jobTasks: AgentJobTask[] = tasks.map((task, index) => {
      const agentId = taskAgentSelector(task) || parentChannel;
      return {
        agentId,
        label:      task.label || agentId || `task-${ index }`,
        prompt:     task.prompt,
        taskId:     task.projectTaskId?.trim(),
        status:     'queued',
        visibility: 'hidden',
        contract:   contracts[index],
        depth:      parentDepth + 1,
      };
    });
    const jobOptions = { visibility: 'hidden' as const, parentAgentId };

    // Abort signal for THIS job (set once the job is created below).
    // Threaded into each sub-agent so stop_agent_job(jobId) can cancel them.
    let jobAbortSignal: AbortSignal | undefined;
    // Set once a job exists; its id is the dead-run activity key for the job.
    let activityJobId: string | undefined;
    // Delegation-log row per task index, so delivery can be recorded later.
    const delegationIds: (string | null)[] = [];

    // ── Task ownership ──────────────────────────────────────────
    // A job that works a Projects task owns it for its whole run. Ownership is
    // taken before anything launches, under one advisory lock, so this job
    // and another session's job for the same task can't both win.
    const inherited = inheritedTaskIds((this.state as any)?.metadata);
    const assignees: Record<string, string> = {};
    for (const task of tasks) {
      if (task.projectTaskId) assignees[task.projectTaskId.trim()] = taskAgentSelector(task) || parentChannel;
    }
    let ownershipJob: Awaited<ReturnType<typeof createJob>> | undefined;
    if (Object.keys(assignees).length > 0) {
      ownershipJob = await createJob(jobTasks, parentChannel, parentThreadId, jobOptions);
      const { WorkTaskOwnershipModel } = await import('../../database/models/WorkTaskOwnershipModel');
      let refusal: string | undefined;
      try {
        const claim = await WorkTaskOwnershipModel.claimForJob(ownershipJob.jobId, assignees, inherited);
        if (!claim.claimed) {
          refusal = `Not launched: ${ claim.conflicts.map(owner => `task ${ owner.taskId } is owned by ${ owner.kind } ${ owner.ref }`).join('; ') }. ` +
            'Only one agent may work a task at a time. Wait for that owner to finish, or work a different task.';
        }
      } catch (err) {
        refusal = `Not launched: could not take ownership of ${ Object.keys(assignees).join(', ') } (${ (err as Error).message }).`;
      }
      if (refusal) {
        await this.rejectTasks(tasks, refusal);
        deleteJob(ownershipJob.jobId);
        return { successBoolean: false, responseString: refusal };
      }
    }

    // ── Single task executor ────────────────────────────────────
    const executeSingle = async(task: SpawnTask, index: number): Promise<AgentJobResult> => {
      const selector = taskAgentSelector(task);
      const label = task.label || selector || `task-${ index }`;
      const agentConfigChannel = selector || parentChannel;
      const contract = contracts[index];
      const threadId = `spawn-agent-${ label.replace(/\s+/g, '-').toLowerCase() }-${ Date.now() }-${ index }`;
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
      try {
        const { graph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(
          agentConfigChannel,
          threadId,
        ) as { graph: any; state: any };
        subStateRef = subState;

        // Inject the brief and its return contract.
        subState.messages.push({
          role:    'user',
          content: activityJobId
            ? `${ task.prompt }\n\n${ contractFooter({ jobId: activityJobId, contract, visibility: 'hidden' }) }`
            : task.prompt,
        });

        // Mark as sub-agent. Spawned agents do real delegated work — primary
        // model chain, not the subconscious observer slot.
        subState.metadata.isSubAgent = true;
        subState.metadata.modelSlot = 'primary';
        subState.metadata.subAgentDepth = parentDepth + 1;
        subState.metadata.workflowParentChannel = parentChannel;
        subState.metadata.delegatedJobId = activityJobId;
        // While this runner drives the graph, a human typing into the thread
        // (after "Open in tab") steers it instead of starting a second run.
        subState.metadata.delegatedRunActive = true;
        // Activity flows up: anything this sub-agent does keeps its parent run
        // (and this job) alive for dead-run detection.
        subState.metadata.activityKeys = RunActivity.inherit(
          (this.state as any)?.metadata, ...(activityJobId ? [activityJobId] : []),
        );
        // Ownership flows down: a sub-agent may delegate the tasks it holds.
        subState.metadata.ownedProjectTaskIds = [...new Set([
          ...inherited,
          ...(task.projectTaskId ? [task.projectTaskId.trim()] : []),
        ])];

        // Propagate abort so both the user's stop button (parent AbortService)
        // AND stop_agent_job(jobId) (this job's signal) reach the sub-agents.
        // options.abort is typed AbortService everywhere else (Graph / BaseNode /
        // throwIfAborted). The 2026-07-15 wiring treated it as AbortSignal and
        // called AbortSignal.any([AbortService, jobSignal]) — TypeError:
        // "signals[0] must be AbortSignal". Keep the contract: always write
        // an AbortService that fans out from whichever sources exist.
        const parentAbort = (this.state as any)?.metadata?.options?.abort;
        const combined = combineAborts(parentAbort, jobAbortSignal);

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

        const runLocation = String(subState.metadata.agent?.runLocation ?? 'vm');
        if (runLocation === 'container') {
          const provider = String(subState.metadata.agent?.provider ?? '').trim();
          if (provider !== 'claude-code' && provider !== 'codex') {
            throw new Error(`Agent ${ selector ?? label } uses run_location=container but provider ${ provider || '(unset)' } is not a CLI worker`);
          }
          if (!activityJobId) throw new Error('Container agents require a durable job identity');
          const persistenceNotice = `\n\n[Container workspace] Work in the job workspace shown by pwd. It is a bounded host-backed directory that survives container exit; do not write outside it. The container itself is always removed when the job ends.`;
          const promptMessage = subState.messages[subState.messages.length - 1];
          const prompt = `${ typeof promptMessage?.content === 'string' ? promptMessage.content : task.prompt }${ persistenceNotice }`;
          const instructions = [
            String(subState.metadata.agent?.prompt ?? ''),
            'Use the baked-in `sulla` CLI for Sulla tools. Call agents/return_result before exiting.',
          ].filter(Boolean).join('\n\n');
          const { runAgentContainer } = await import('../../services/AgentContainerLauncher');
          const container = await runAgentContainer({
            jobId: activityJobId,
            taskIndex: index,
            provider,
            model: subState.metadata.agent?.model,
            prompt,
            instructions,
            state: subState,
            signal: jobAbortSignal,
          });
          const settled = (await getJob(activityJobId))?.tasks[index];
          const result = settled?.returnedAt
            ? returnedJobResult(settled, label, threadId)
            : { label, status: 'error' as const, output: `failed: no_contract — container exited without returning its "${ contract.name }" contract.\n\nOutput:\n${ container.output }`, threadId, contract: contract.name };
          await safeFinishDelegation(delegationId, {
            outcome: result.status === 'completed' ? 'completed' : 'failed',
            detail: result.status === 'completed' ? '' : `${ result.status }: ${ result.output }`,
          });
          await updateJobTask(activityJobId, index, { status: result.status, threadId, finishedAt: Date.now() });
          await emitSubAgentExchange(parentChannel, parentThreadId, {
            direction: 'from_agent',
            agentId: selector || parentChannel,
            label,
            summary: result.status === 'completed' ? `${ label } finished` : `${ label } is ${ result.status }`,
            detail: result.output,
            status: result.status === 'completed' ? 'done' : 'failed',
            jobId: activityJobId,
            taskIndex: index,
            conversationId: threadId,
          });
          return result;
        }

        // Execute the sub-agent graph
        let finalState = await graph.execute(subState);
        const returnedTask = async() => {
          if (!activityJobId) return undefined;
          const settled = (await getJob(activityJobId))?.tasks[index];
          return settled?.returnedAt ? settled : undefined;
        };

        // A caller schema means free text is not an answer: remind once.
        let returned = await returnedTask();
        if (!returned && contract.schema && jobAbortSignal?.aborted !== true) {
          subState.messages.push({ role: 'user', content: CONTRACT_REMINDER });
          finalState = await graph.execute(subState);
          returned = await returnedTask();
        }

        let result: AgentJobResult;
        if (returned) {
          result = returnedJobResult(returned, label, threadId);
        } else {
          // Canonical blocked-branch + output-fallback chain for spawned jobs.
          const { status, text } = extractAgentTurnOutcome(finalState);
          result = contract.schema && status !== 'blocked'
            ? { label, status: 'error', output: `failed: no_contract — ${ label } ended without returning its "${ contract.name }" contract.\n\nLast message:\n${ text }`, threadId, contract: contract.name }
            : { label, status, output: text, threadId, contract: contract.name };
        }

        await safeFinishDelegation(delegationId, {
          outcome: result.status === 'completed' ? 'completed' : 'failed',
          detail:  result.status === 'completed' ? '' : `${ result.status }: ${ result.output }`,
        });
        if (activityJobId) {
          await updateJobTask(activityJobId, index, { status: result.status, threadId, finishedAt: Date.now() });
          await emitSubAgentExchange(parentChannel, parentThreadId, {
            direction: 'from_agent',
            agentId: selector || parentChannel,
            label,
            summary: result.status === 'completed' ? `${ label } finished` : `${ label } is ${ result.status }`,
            detail: result.output,
            status: result.status === 'completed' ? 'done' : 'failed',
            jobId: activityJobId,
            taskIndex: index,
            conversationId: threadId,
          });
        }
        return result;
      } catch (err) {
        const output = `Error: ${ (err as Error).message }`;
        const stopped = jobAbortSignal?.aborted === true;
        await safeFinishDelegation(delegationId, { outcome: 'failed', detail: `${ stopped ? 'stopped' : 'error' }: ${ output }` });
        if (activityJobId) {
          await updateJobTask(activityJobId, index, { status: stopped ? 'stopped' : 'error', threadId, finishedAt: Date.now() });
          await emitSubAgentExchange(parentChannel, parentThreadId, {
            direction: 'from_agent',
            agentId: selector || parentChannel,
            label,
            summary: stopped ? `${ label } was stopped` : `${ label } failed`,
            detail: output,
            status: stopped ? 'stopped' : 'failed',
            jobId: activityJobId,
            taskIndex: index,
            conversationId: threadId,
          });
        }
        return {
          label,
          status:   'error',
          output,
          threadId,
        };
      } finally {
        if (subStateRef?.metadata) subStateRef.metadata.delegatedRunActive = false;
        // Deregister from parent's active-sub-agents list so stale threadIds
        // don't receive abort signals after the subagent has already exited
        const parentMeta = (this.state as any)?.metadata;
        if (parentMeta?.activeSubAgentThreadIds) {
          const arr: string[] = parentMeta.activeSubAgentThreadIds;
          const idx = arr.indexOf(threadId);
          if (idx >= 0) arr.splice(idx, 1);
        }
        // Clean up registry to prevent memory leaks
        GraphRegistry.delete(threadId);
      }
    };

    // ── Execute all tasks (parallel or sequential) ──────────────
    const executeAll = async(): Promise<AgentJobResult[]> => {
      if (tasks.length === 1 || !parallel) {
        // Sequential execution
        const results: AgentJobResult[] = [];

        for (let i = 0; i < tasks.length; i++) {
          results.push(await executeSingle(tasks[i], i));
        }

        return results;
      }

      // Parallel execution
      const settled = await Promise.allSettled(
        tasks.map((task, i) => executeSingle(task, i)),
      );

      return settled.map((s, i) => {
        if (s.status === 'fulfilled') {
          return s.value;
        }

        return {
          label:    tasks[i].label || taskAgentSelector(tasks[i]) || `task-${ i }`,
          status:   'error' as const,
          output:   `Unexpected error: ${ s.reason }`,
          threadId: '',
        };
      });
    };

    // ── Async mode: fire and forget ─────────────────────────────
    if (async_) {
      const job = ownershipJob ?? await createJob(jobTasks, parentChannel, parentThreadId, jobOptions);
      const { beginAgentScratch, endAgentScratch } = await import('../../files/scratchLifecycle');
      await beginAgentScratch(job.jobId, String((this.state as any)?.metadata?.userId ?? parentChannel), (this.state as any)?.metadata?.orgId);
      // Wire this job's abort signal in BEFORE launching, so a stop_agent_job
      // call fans out to every sub-agent this job spawns.
      jobAbortSignal = getJobAbortSignal(job.jobId);
      activityJobId = job.jobId;

      // A job whose whole agent tree goes silent is dead: stop it (which hands
      // back any task it owns) and tell the parent, instead of waiting forever
      // on a provider call that will never return.
      let stoppedAsDead = false;
      const stopDeadRunWatch = watchForDeadRun(job.jobId, async(reason) => {
        if (abortJob(job.jobId) !== 'stopped') return;
        stoppedAsDead = true;
        const message = `dead run: ${ reason }; job stopped`;
        console.warn(`[spawn_agent] Async job ${ job.jobId } ${ message }`);
        await emitProactiveCompletion(parentChannel, job.jobId, [], message, parentThreadId);
        await wakeParentGraph(parentChannel, parentThreadId, job.jobId, [], message);
      });

      // Launch in background — do not await
      executeAll()
        .then(async(results) => {
          await completeJob(job.jobId, results);
          if (stoppedAsDead) return; // the parent was already told

          console.log(`[spawn_agent] Async job ${ job.jobId } completed — ${ results.length } result(s)`);
          await emitProactiveCompletion(parentChannel, job.jobId, results, undefined, parentThreadId);
          // Feed the results back INTO the orchestrator's loop, not just onto a
          // UI card. Without this the parent's turn already ended and nothing
          // re-invokes it — the results would strand and the orchestrator would
          // report that the sub-agents "died".
          const delivered = await wakeParentGraph(parentChannel, parentThreadId, job.jobId, results);
          if (delivered) {
            await markCompletionDelivered(job.jobId);
            await safeMarkDelegationsDelivered(delegationIds);
          }
        })
        .catch(async(err) => {
          failJob(job.jobId, (err as Error).message);
          console.error(`[spawn_agent] Async job ${ job.jobId } failed:`, err);
          if (stoppedAsDead) return;
          await emitProactiveCompletion(parentChannel, job.jobId, [], (err as Error).message, parentThreadId);
          wakeParentGraph(parentChannel, parentThreadId, job.jobId, [], (err as Error).message);
        })
        .finally(async() => { stopDeadRunWatch(); await endAgentScratch(job.jobId) });

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          mode:      'async',
          jobId:     job.jobId,
          taskCount: tasks.length,
          parallel,
          message:   `${ tasks.length } sub-agent(s) launched in the background. Results will wake this graph when they finish (check_agent_jobs is the fallback/history read).`,
        }, null, 2),
      };
    }

    // ── Sync mode: block until complete ─────────────────────────
    // Sync launches need a durable job too: otherwise the rail and exchange
    // components would only exist for fire-and-forget work.
    const syncJob = ownershipJob ?? await createJob(jobTasks, parentChannel, parentThreadId, jobOptions);
    const { beginAgentScratch, endAgentScratch } = await import('../../files/scratchLifecycle');
    await beginAgentScratch(syncJob.jobId, String((this.state as any)?.metadata?.userId ?? parentChannel), (this.state as any)?.metadata?.orgId);
    let stopDeadRunWatch: (() => void) | undefined;
    const jobId = syncJob.jobId;
    jobAbortSignal = getJobAbortSignal(jobId);
    activityJobId = jobId;
    // Stopping a dead job hands its tasks back even if the hung call never returns.
    stopDeadRunWatch = watchForDeadRun(jobId, (reason) => {
      if (abortJob(jobId) === 'stopped') console.warn(`[spawn_agent] Sync job ${ jobId } dead run: ${ reason }; job stopped`);
    });
    let results: AgentJobResult[];
    try {
      results = await executeAll();
    } catch (err) {
      failJob(syncJob.jobId, (err as Error).message);
      throw err;
    } finally {
      stopDeadRunWatch?.();
      await endAgentScratch(syncJob.jobId);
    }
    // The caller is reading the results right here; only the durable display /
    // ownership record needs settling, not a background wake.
    await completeJob(syncJob.jobId, results);
    await markCompletionDelivered(syncJob.jobId);
    await safeMarkDelegationsDelivered(delegationIds);

    const allSuccess = results.every(r => r.status === 'completed');

    const formatted = results.map(r =>
      `### ${ r.label } [${ r.status.toUpperCase() }]\n${ r.output }`,
    ).join('\n\n---\n\n');

    return {
      successBoolean: allSuccess,
      responseString: tasks.length === 1
        ? results[0].output
        : `${ results.length } sub-agent(s) completed.\n\n${ formatted }`,
    };
  }
}
