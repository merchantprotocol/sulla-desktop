import { BaseTool, ToolResponse } from '../base';
import { extractAgentTurnOutcome } from './agentTurnOutcome';
import { createJob, completeJob, failJob, getJobAbortSignal } from './jobRegistry';
import { getWebSocketClientService } from '../../services/WebSocketClientService';
import { combineAborts } from '../../services/AbortService';
import { findAgentDir } from '../../utils/sullaPaths';

import type { AgentJobResult } from './jobRegistry';

const MAX_DEPTH = 3;
const MAX_TASKS = 10;

interface SpawnTask {
  agentId?:   string;
  /** Alias for agentId — the agent config folder name under ~/sulla/agents/.
   *  Accepted because callers routinely reach for "agentName"; resolved to the
   *  same selector so a natural-but-wrong key no longer silently no-ops. */
  agentName?: string;
  prompt:     string;
  label?:     string;
}

/** The agent-config selector for a task: agentId, or its agentName alias. */
function taskAgentSelector(task: SpawnTask): string | undefined {
  const sel = task.agentId || task.agentName;
  return typeof sel === 'string' && sel.trim() ? sel.trim() : undefined;
}

export class SpawnAgentWorker extends BaseTool {
  name = '';
  description = '';

  /** Reuse the canonical spawn path from compatibility wrappers. */
  public runValidated(input: any, state?: any): Promise<ToolResponse> {
    if (state) this.setState(state);

    return this._validatedCall(input);
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    // ── Validate tasks ──────────────────────────────────────────
    const tasks: SpawnTask[] = input.tasks;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return {
        successBoolean: false,
        responseString: 'tasks is required and must be a non-empty array of { prompt, agentId?, label? } objects.',
      };
    }

    if (tasks.length > MAX_TASKS) {
      return {
        successBoolean: false,
        responseString: `Too many tasks (${ tasks.length }). Maximum is ${ MAX_TASKS } per call.`,
      };
    }

    for (let i = 0; i < tasks.length; i++) {
      if (!tasks[i].prompt || typeof tasks[i].prompt !== 'string') {
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } is missing a "prompt" string.`,
        };
      }

      // Fail fast on an unresolvable agent selector. Without this the task
      // silently fell back to the PARENT persona on the subconscious model
      // (e.g. a caller passing the wrong key ran a generic sub-agent on the
      // fallback provider instead of the intended worker) — a costly no-op
      // with no signal. A missing selector is still fine (documented default).
      const selector = taskAgentSelector(tasks[i]);
      if (selector && !findAgentDir(selector)) {
        return {
          successBoolean: false,
          responseString: `Task at index ${ i } references agent "${ selector }" but no config folder exists under ~/sulla/agents/. Use a valid agentId (or omit it to use the default agent).`,
        };
      }
    }

    // ── Options ───────────────────────────────────────────────────
    const parallel: boolean = input.parallel !== false; // default true
    const async_: boolean = input.async !== false;       // default true

    // ── Depth guard ─────────────────────────────────────────────
    const parentDepth: number = (this.state)?.metadata?.subAgentDepth ?? 0;

    if (parentDepth >= MAX_DEPTH) {
      return {
        successBoolean: false,
        responseString: `Sub-agent depth limit reached (${ MAX_DEPTH }). Cannot spawn further sub-agents. Complete your work and return results to the parent agent.`,
      };
    }

    // ── Lazy imports (keep out of renderer bundle) ──────────────
    const { GraphRegistry } = await import('../../services/GraphRegistry');

    const parentChannel = (this.state)?.metadata?.wsChannel || 'sulla-desktop';
    // The orchestrator's own conversation thread. Async jobs use this to wake
    // the parent graph with their results when they finish, so an orchestrator
    // that fired-and-forgot doesn't sit thinking its sub-agents "died".
    const parentThreadId: string | undefined = (this.state as any)?.metadata?.threadId;

    // Abort signal for THIS async job (set once the job is created below).
    // Threaded into each sub-agent so stop_agent_job(jobId) can cancel them.
    let jobAbortSignal: AbortSignal | undefined;

    // ── Single task executor ────────────────────────────────────
    const executeSingle = async(task: SpawnTask, index: number): Promise<AgentJobResult> => {
      const selector = taskAgentSelector(task);
      const label = task.label || selector || `task-${ index }`;
      const agentConfigChannel = selector || parentChannel;
      const threadId = `spawn-agent-${ label.replace(/\s+/g, '-').toLowerCase() }-${ Date.now() }-${ index }`;

      try {
        const { graph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(
          agentConfigChannel,
          threadId,
        ) as { graph: any; state: any };

        // Inject the task prompt
        subState.messages.push({ role: 'user', content: task.prompt });

        // Mark as sub-agent
        subState.metadata.isSubAgent = true;
        subState.metadata.subAgentDepth = parentDepth + 1;
        subState.metadata.workflowParentChannel = parentChannel;

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

        // Execute the sub-agent graph
        const finalState = await graph.execute(subState);

        // Canonical blocked-branch + output-fallback chain for spawned jobs.
        const { status, text } = extractAgentTurnOutcome(finalState);

        return {
          label,
          status,
          output: text,
          threadId,
        };
      } catch (err) {
        return {
          label,
          status:   'error',
          output:   `Error: ${ (err as Error).message }`,
          threadId,
        };
      } finally {
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
      const job = await createJob(tasks.length, parentChannel, parentThreadId);
      // Wire this job's abort signal in BEFORE launching, so a stop_agent_job
      // call fans out to every sub-agent this job spawns.
      jobAbortSignal = getJobAbortSignal(job.jobId);

      // Launch in background — do not await
      executeAll()
        .then(async(results) => {
          await completeJob(job.jobId, results);
          console.log(`[spawn_agent] Async job ${ job.jobId } completed — ${ results.length } result(s)`);
          await emitProactiveCompletion(parentChannel, job.jobId, results);
          // Feed the results back INTO the orchestrator's loop, not just onto a
          // UI card. Without this the parent's turn already ended and nothing
          // re-invokes it — the results would strand and the orchestrator would
          // report that the sub-agents "died".
          const delivered = await wakeParentGraph(parentChannel, parentThreadId, job.jobId, results);
          const { markCompletionDelivered } = await import('./jobRegistry');
          if (delivered) await markCompletionDelivered(job.jobId);
        })
        .catch(async(err) => {
          failJob(job.jobId, (err as Error).message);
          console.error(`[spawn_agent] Async job ${ job.jobId } failed:`, err);
          await emitProactiveCompletion(parentChannel, job.jobId, [], (err as Error).message);
          wakeParentGraph(parentChannel, parentThreadId, job.jobId, [], (err as Error).message);
        });

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
    const results = await executeAll();

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

// ─── Parent-graph wake ───────────────────────────────────────────
// Re-enters the orchestrator's own graph loop with the finished sub-agent
// results as input. The proactive card (below) is display-only — the
// MessageDispatcher 'proactive' handler pushes it to the message list WITHOUT
// calling graph.execute(), so on its own it never wakes the orchestrator.
//
// This sends a `user_message` on the parent channel + thread, which loops back
// through getWebSocketClientService() into BackendGraphWebSocketService and
// runs a fresh turn on the SAME thread (the exact primitive the inter-agent
// `<channel:x wake>` tag uses). Because the orchestrator's turn has already
// ended by the time an async job settles, that thread is idle and the wake
// runs cleanly, injecting the results straight into its reasoning loop.
//
// No-op when there is no parent thread to resume (falls back to card-only,
// the legacy behaviour).
async function wakeParentGraph(
  parentChannel: string,
  parentThreadId: string | undefined,
  jobId: string,
  results: AgentJobResult[],
  failureReason?: string,
): Promise<boolean> {
  if (!parentThreadId) return false;

  try {
    const ws = getWebSocketClientService();
    const content = buildWakeContent(jobId, results, failureReason);

    await ws.send(parentChannel, {
      type: 'user_message',
      data: {
        content,
        threadId: parentThreadId,
        metadata: {
          // Marks this as a background-completion wake rather than human input,
          // so downstream nodes/telemetry can tell it apart from typed messages.
          source:      'sub_agent_completion',
          origin:      'spawn_agent',
          inputSource: 'system',
          jobId,
        },
      },
    });
    console.log(`[spawn_agent] Woke parent graph — channel="${ parentChannel }" thread="${ parentThreadId.slice(-8) }" job=${ jobId }`);
    return true;
  } catch (e) {
    console.warn('[spawn_agent] wakeParentGraph failed:', e);
    return false;
  }
}

/** Format the finished job as an orchestrator-facing input message. */
function buildWakeContent(
  jobId: string,
  results: AgentJobResult[],
  failureReason?: string,
): string {
  if (failureReason) {
    return `[sub-agent job ${ jobId } FAILED] ${ failureReason }\n\n` +
      'Your background sub-agent(s) errored before returning results. Decide how to proceed (retry, adjust, or report back).';
  }

  const formatted = results.map(r =>
    `### ${ r.label } [${ r.status.toUpperCase() }]\n${ r.output }`,
  ).join('\n\n---\n\n');

  return `[sub-agent job ${ jobId } complete — ${ results.length } result(s)]\n\n` +
    'These are the results returned by the background sub-agent(s) you launched. ' +
    'Continue your orchestration using them (do NOT call check_agent_jobs for this job — the results are below):\n\n' +
    formatted;
}

// ─── Proactive completion emitter ────────────────────────────────
// Surfaces a ProactiveCard in the parent channel's chat when an async
// spawn_agent job finishes. The parent graph is woken automatically
// with the full results; this card is a user-facing heads-up that
// the background work settled.
async function emitProactiveCompletion(
  parentChannel: string,
  jobId: string,
  results: AgentJobResult[],
  failureReason?: string,
): Promise<void> {
  try {
    const ws = getWebSocketClientService();

    let headline: string;
    let body: string;
    if (failureReason) {
      headline = 'Background agents failed';
      body = `Job ${ jobId } errored: ${ failureReason.slice(0, 200) }`;
    } else {
      const done = results.filter(r => r.status === 'completed').length;
      const blocked = results.filter(r => r.status === 'blocked').length;
      const errored = results.filter(r => r.status === 'error').length;
      const labels = results.map(r => r.label).slice(0, 3).join(', ');
      headline = errored > 0 || blocked > 0
        ? `Background agents finished — ${ done } done, ${ blocked } blocked, ${ errored } failed`
        : `Background agents finished — ${ done }/${ results.length } complete`;
      body = results.length === 1
        ? `Task "${ results[0].label }" is ready. Check \`check_agent_jobs("${ jobId }")\` for the full result.`
        : `Tasks: ${ labels }${ results.length > 3 ? `, +${ results.length - 3 } more` : '' }. Check \`check_agent_jobs("${ jobId }")\` for results.`;
    }

    ws.send(parentChannel, {
      type: 'chat_message',
      data: {
        kind: 'proactive',
        role: 'assistant',
        headline,
        body,
        content: body,
      },
    });
  } catch (e) {
    console.warn('[spawn_agent] proactive emit failed:', e);
  }
}
