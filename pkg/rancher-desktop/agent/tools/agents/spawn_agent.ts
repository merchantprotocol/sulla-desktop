import { BaseTool, ToolResponse } from '../base';

const MAX_DEPTH = 3;
const MAX_TASKS = 10;

interface SpawnTask {
  agentId?: string;
  prompt:   string;
  label?:   string;
}

interface SpawnResult {
  label:    string;
  status:   'completed' | 'blocked' | 'error';
  output:   string;
  threadId: string;
}

export class SpawnAgentWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    // ── Validate tasks ──────────────────────────────────────────
    let tasks: SpawnTask[] = input.tasks;

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

    // ── Depth guard ─────────────────────────────────────────────
    const parentDepth: number = (this.state as any)?.metadata?.subAgentDepth ?? 0;

    if (parentDepth >= MAX_DEPTH) {
      return {
        successBoolean: false,
        responseString: `Sub-agent depth limit reached (${ MAX_DEPTH }). Cannot spawn further sub-agents. Complete your work and return results to the parent agent.`,
      };
    }

    // ── Lazy imports (keep out of renderer bundle) ──────────────
    const { GraphRegistry } = await import('../../services/GraphRegistry');
    const { getTrainingDataLogger } = await import('../../services/TrainingDataLogger');

    const parentChannel = (this.state as any)?.metadata?.wsChannel || 'sulla-desktop';
    const parentConvId = (this.state as any)?.metadata?.conversationId;
    const trainingLogger = getTrainingDataLogger();

    // ── Execute tasks ───────────────────────────────────────────
    const executeSingle = async(task: SpawnTask, index: number): Promise<SpawnResult> => {
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

        // Training data: start session
        trainingLogger.startSession(threadId, { agentId: agentConfigChannel });

        // Execute the sub-agent graph
        const finalState = await graph.execute(subState);

        // Training data: embed into parent conversation
        if (parentConvId && trainingLogger.hasSession(parentConvId)) {
          trainingLogger.embedSubAgentConversation(parentConvId, threadId, label);
        }

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

    // ── Single vs. parallel execution ───────────────────────────
    let results: SpawnResult[];

    if (tasks.length === 1) {
      results = [await executeSingle(tasks[0], 0)];
    } else {
      const settled = await Promise.allSettled(
        tasks.map((task, i) => executeSingle(task, i)),
      );

      results = settled.map((s, i) => {
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
    }

    // ── Format response ─────────────────────────────────────────
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
