import { BaseTool, ToolResponse } from '../base';
import { createJob, completeJob, failJob } from './jobRegistry';
import { getWebSocketClientService } from '../../services/WebSocketClientService';

import type { AgentJobResult } from './jobRegistry';

const MAX_DEPTH = 3;
const MAX_TASKS = 10;

interface SpawnTask {
  agentId?: string;
  prompt:   string;
  label?:   string;
}

export class SpawnAgentWorker extends BaseTool {
  name = '';
  description = '';

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

    // ── Single task executor ────────────────────────────────────
    const executeSingle = async(task: SpawnTask, index: number): Promise<AgentJobResult> => {
      const label = task.label || task.agentId || `task-${ index }`;
      const agentConfigChannel = task.agentId || parentChannel;
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

        // Execute the sub-agent graph
        const finalState = await graph.execute(subState);

        // Check if blocked
        const agentMeta = finalState.metadata?.agent || {};
        const agentStatus = String(agentMeta.status || '').toLowerCase();

        if (agentStatus === 'blocked') {
          const blockerReason = agentMeta.blocker_reason || 'Unknown blocker';
          const unblockReqs = agentMeta.unblock_requirements || '';

          return {
            label,
            status:   'blocked',
            output:   `[BLOCKED] ${ blockerReason }${ unblockReqs ? ` | Requirements: ${ unblockReqs }` : '' }`,
            threadId,
          };
        }

        // Extract result
        const output = finalState.metadata?.finalSummary ||
          finalState.messages?.[finalState.messages.length - 1]?.content ||
          '(no output)';

        return {
          label,
          status: 'completed',
          output: typeof output === 'string' ? output : JSON.stringify(output),
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
          label:    tasks[i].label || tasks[i].agentId || `task-${ i }`,
          status:   'error' as const,
          output:   `Unexpected error: ${ s.reason }`,
          threadId: '',
        };
      });
    };

    // ── Async mode: fire and forget ─────────────────────────────
    if (async_) {
      const job = createJob(tasks.length);

      // Launch in background — do not await
      executeAll()
        .then(async(results) => {
          completeJob(job.jobId, results);
          console.log(`[spawn_agent] Async job ${ job.jobId } completed — ${ results.length } result(s)`);
          await emitProactiveCompletion(parentChannel, job.jobId, results);
        })
        .catch(async(err) => {
          failJob(job.jobId, (err as Error).message);
          console.error(`[spawn_agent] Async job ${ job.jobId } failed:`, err);
          await emitProactiveCompletion(parentChannel, job.jobId, [], (err as Error).message);
        });

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          mode:      'async',
          jobId:     job.jobId,
          taskCount: tasks.length,
          parallel,
          message:   `${ tasks.length } sub-agent(s) launched in the background. Use check_agent_jobs(jobId: "${ job.jobId }") to poll for results.`,
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

// ─── Proactive completion emitter ────────────────────────────────
// Surfaces a ProactiveCard in the parent channel's chat when an async
// spawn_agent job finishes. The parent agent will still poll via
// check_agent_jobs to read the full results — this card is a user-
// facing heads-up that the background work settled.
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
