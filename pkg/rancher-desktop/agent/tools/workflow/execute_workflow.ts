import { createPlaybookState, createPlaybookStateFromNode } from '../../workflow/WorkflowPlaybook';
import { BaseTool, ToolResponse } from '../base';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';

import type { PlaybookNodeOutput, WorkflowPlaybookState } from '../../workflow/types';

export interface ActivateWorkflowInput {
  workflowId: string;
  message?:   string;
  /**
   * True = resume the most recent checkpoint for this workflow. Mutually
   * exclusive with `resumeExecutionId` (which targets a specific prior run).
   */
  resume?:    boolean;
  /**
   * Resume a specific prior execution by its executionId. The walker seeds
   * every completed node's output from that run's checkpoints and restarts
   * at the first node past the last checkpoint.
   */
  resumeExecutionId?: string;
  /**
   * Start the walker at this node, skipping everything upstream. Used by
   * the "Run from here" context menu. Ignored when `resume` /
   * `resumeExecutionId` is set.
   */
  startNodeId?: string;
}

export interface ActivateWorkflowResult {
  ok:             boolean;
  /** JSON-ready string for the caller to surface to the model. */
  responseString: string;
}

/**
 * Core workflow-activation logic. Mutates `state.metadata.activeWorkflow`
 * so the orchestrating graph picks it up on the next cycle.
 *
 * Exported separately from ExecuteWorkflowWorker so the in-process MCP
 * bridge can reuse the exact same code path when Claude Code calls the
 * workflow tool over MCP — the mutation has to happen on the calling
 * graph's live state, which only works if the handler runs in-process.
 */
export async function activateWorkflowOnState(
  state: BaseThreadState,
  input: ActivateWorkflowInput,
): Promise<ActivateWorkflowResult> {
  const { workflowId } = input;

  if (!workflowId) {
    return {
      ok:             false,
      responseString: 'workflowId is required. Pass the workflow slug (filename without extension) from your system prompt.',
    };
  }

  // If scoped to a specific workflow (e.g. from workflow editor), enforce it.
  // The scope may be an internal ID (e.g. "workflow-1773725042351") while the
  // user passes a slug (e.g. "daily-planning"), so resolve both ways.
  const scopedWorkflowId = state.metadata?.scopedWorkflowId;
  if (scopedWorkflowId && workflowId !== scopedWorkflowId) {
    let matches = false;
    try {
      const { getWorkflowRegistry } = await import('../../workflow/WorkflowRegistry');
      const resolved = await getWorkflowRegistry().loadWorkflow(workflowId);
      matches = resolved?.id === scopedWorkflowId;
    } catch { /* not found — doesn't match */ }
    if (!matches) {
      return {
        ok:             false,
        responseString: `You can only execute workflow "${ scopedWorkflowId }" in this context. Check your available workflows in the system prompt.`,
      };
    }
  }

  // Resolve the trigger message from input or last user message. Empty is OK —
  // the playbook will substitute the routine framing into the trigger node's
  // output. Routines fired with no user payload (e.g. Desktop "Run" button)
  // rely on this path.
  let message = input.message || '';

  if (!message) {
    const messages = state.messages;
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && messages[i].content) {
          message = String(messages[i].content);
          break;
        }
      }
    }
  }

  // Load the workflow definition via the registry (DB-backed).
  let definition: WorkflowDefinition | null = null;

  try {
    const { getWorkflowRegistry } = await import('../../workflow/WorkflowRegistry');
    const registry = getWorkflowRegistry();
    definition = await registry.loadWorkflow(workflowId);
  } catch (err) {
    return {
      ok:             false,
      responseString: `Workflow "${ workflowId }" could not be loaded: ${ err instanceof Error ? err.message : String(err) }`,
    };
  }

  if (!definition) {
    let available = '';
    try {
      const { WorkflowModel } = await import('../../database/models/WorkflowModel');
      const rows = await WorkflowModel.listByStatus('production');
      const slugs = rows
        .map((row) => {
          const def = row.attributes.definition as (WorkflowDefinition & { slug?: string; _slug?: string }) | undefined;
          return def?.slug ?? def?._slug ?? row.attributes.id;
        })
        .filter(Boolean);
      if (slugs.length > 0) {
        available = ` Available production workflow slugs: ${ slugs.join(', ') }.`;
      } else {
        available = ' No production workflows are currently registered — do not keep guessing slugs; tell the user there is nothing to run.';
      }
    } catch { /* if the list lookup fails, fall through with the base message */ }
    return {
      ok:             false,
      responseString: `Workflow "${ workflowId }" not found.${ available } Do NOT retry with a different guess — either pick one of the slugs above exactly, or stop and ask the user.`,
    };
  }

  // Enforce trigger-type gating: if the caller has a wsChannel that maps to a
  // specific trigger type, only allow workflows that have a matching trigger node.
  // This prevents heartbeat agents from executing schedule-only workflows, etc.
  const wsChannel = state.metadata?.wsChannel;
  const gatedTriggers = ['heartbeat', 'calendar', 'schedule'];
  if (wsChannel && gatedTriggers.includes(wsChannel)) {
    const hasTrigger = (definition.nodes || []).some(
      (node: any) => node.data?.category === 'trigger' && node.data?.subtype === wsChannel,
    );
    if (!hasTrigger) {
      return {
        ok:             false,
        responseString: `Workflow "${ workflowId }" does not have a "${ wsChannel }" trigger. You can only execute workflows that match your trigger type. Check your available workflows in the system prompt.`,
      };
    }
  }

  // Resume a specific prior execution (user clicked Resume on a row in the
  // Previous runs list). Walk every checkpoint for that executionId, seed
  // each completed node's output, and hand the walker a fresh frontier that
  // sits just past the last checkpoint.
  const resumeExecutionId = typeof input.resumeExecutionId === 'string' ? input.resumeExecutionId.trim() : '';
  if (resumeExecutionId) {
    try {
      const { WorkflowCheckpointModel } = await import('../../database/models/WorkflowCheckpointModel');
      const checkpoints = await WorkflowCheckpointModel.findByExecution(resumeExecutionId);

      if (checkpoints.length === 0) {
        return {
          ok:             false,
          responseString: `No checkpoints found for executionId "${ resumeExecutionId }" — cannot resume.`,
        };
      }

      // Most recent checkpoint holds the full playbook_state at that
      // moment. That's the cleanest restart point — everything the walker
      // needs (completedNodeIds, currentNodeIds, nodeOutputs, loopState).
      const latest = checkpoints[checkpoints.length - 1].attributes as any;
      const savedState = latest.playbook_state as WorkflowPlaybookState | undefined;

      if (savedState?.definition) {
        const resumedState: WorkflowPlaybookState = {
          ...savedState,
          // Keep the old executionId visible in logs but generate a new one
          // so new checkpoints don't stomp on the original run's history.
          executionId:     `${ savedState.executionId }-resume-${ Date.now() }`,
          status:          'running',
          completedAt:     undefined,
          error:           undefined,
          pendingDecision: undefined,
        };

        state.metadata.activeWorkflow = resumedState;

        console.log(`[ExecuteWorkflow] Resuming execution ${ resumeExecutionId } → ${ resumedState.executionId }, completed=${ resumedState.completedNodeIds.length }, frontier=[${ resumedState.currentNodeIds.join(', ') }]`);

        return {
          ok:             true,
          responseString: JSON.stringify({
            executionId:    resumedState.executionId,
            originalExecId: resumeExecutionId,
            workflowSlug:   workflowId,
            workflowName:   definition.name,
            status:         'resumed',
            completedNodes: resumedState.completedNodeIds.length,
            frontierNodes:  resumedState.currentNodeIds,
            message:        `Workflow "${ definition.name }" resumed from execution ${ resumeExecutionId }. ${ resumedState.completedNodeIds.length } nodes already completed. Continuing from frontier: [${ resumedState.currentNodeIds.join(', ') }].`,
          }, null, 2),
        };
      }

      // Older checkpoints pre-date `playbook_state` or didn't persist it.
      // Fall back to seeding node_output per checkpoint and restarting at
      // the last recorded node — the walker will re-run it and advance.
      const seedOutputs: Record<string, PlaybookNodeOutput> = {};
      for (const cp of checkpoints) {
        const a = cp.attributes as any;
        seedOutputs[a.node_id] = {
          nodeId:      a.node_id,
          label:       a.node_label,
          subtype:     a.node_subtype,
          category:    ((definition.nodes.find((n: any) => n.id === a.node_id)?.data as any)?.category ?? 'agent'),
          result:      a.node_output,
          completedAt: a.created_at instanceof Date ? a.created_at.toISOString() : a.created_at,
        };
      }
      const lastNodeId = (checkpoints[checkpoints.length - 1].attributes as any).node_id;
      const playbook = createPlaybookStateFromNode(definition, lastNodeId, seedOutputs);
      state.metadata.activeWorkflow = playbook;

      console.log(`[ExecuteWorkflow] Resumed execution ${ resumeExecutionId } via legacy seed-outputs path → ${ playbook.executionId }, restarting at ${ lastNodeId }`);

      return {
        ok:             true,
        responseString: JSON.stringify({
          executionId:    playbook.executionId,
          originalExecId: resumeExecutionId,
          workflowSlug:   workflowId,
          workflowName:   definition.name,
          status:         'resumed-legacy',
          restartingAt:   lastNodeId,
          message:        `Workflow "${ definition.name }" resumed from execution ${ resumeExecutionId } (legacy path). Restarting at node "${ lastNodeId }".`,
        }, null, 2),
      };
    } catch (err) {
      return {
        ok:             false,
        responseString: `Failed to resume execution "${ resumeExecutionId }": ${ err instanceof Error ? err.message : String(err) }`,
      };
    }
  }

  // Partial run: start the walker at a specific node, synthesising
  // ancestor outputs so downstream dependency checks pass.
  const startNodeId = typeof input.startNodeId === 'string' ? input.startNodeId.trim() : '';
  if (startNodeId) {
    try {
      const playbook = createPlaybookStateFromNode(definition, startNodeId);
      state.metadata.activeWorkflow = playbook;

      console.log(`[ExecuteWorkflow] Partial run of "${ definition.name }" starting at ${ startNodeId } — executionId=${ playbook.executionId }`);

      return {
        ok:             true,
        responseString: JSON.stringify({
          executionId:  playbook.executionId,
          workflowSlug: workflowId,
          workflowName: definition.name,
          status:       'activated-partial',
          startNodeId,
          message:      `Workflow "${ definition.name }" activated as a partial run starting at node "${ startNodeId }".`,
        }, null, 2),
      };
    } catch (err) {
      return {
        ok:             false,
        responseString: `Failed to start workflow "${ workflowId }" at node "${ startNodeId }": ${ err instanceof Error ? err.message : String(err) }`,
      };
    }
  }

  // Only resume from the most recent checkpoint if explicitly requested
  const resume = input.resume === true;

  if (resume) {
    try {
      const { WorkflowCheckpointModel } = await import('../../database/models/WorkflowCheckpointModel');
      const recentExecs = await WorkflowCheckpointModel.recentExecutions(definition.id, 1);

      if (recentExecs.length > 0) {
        const latestCheckpoint = recentExecs[0];
        const savedState = latestCheckpoint.attributes.playbook_state as unknown as WorkflowPlaybookState;

        if (savedState?.definition && savedState.status !== 'completed' && savedState.status !== 'failed') {
          const resumedState: WorkflowPlaybookState = {
            ...savedState,
            executionId:     `${ savedState.executionId }-resume-${ Date.now() }`,
            status:          'running',
            completedAt:     undefined,
            error:           undefined,
            pendingDecision: undefined,
          };

          state.metadata.activeWorkflow = resumedState;

          console.log(`[ExecuteWorkflow] Resuming workflow "${ definition.name }" from checkpoint — original=${ savedState.executionId }, new=${ resumedState.executionId }, completed=${ resumedState.completedNodeIds.length } nodes, frontier=[${ resumedState.currentNodeIds.join(', ') }]`);

          return {
            ok:             true,
            responseString: JSON.stringify({
              executionId:    resumedState.executionId,
              originalExecId: savedState.executionId,
              workflowSlug:   workflowId,
              workflowName:   definition.name,
              status:         'resumed',
              completedNodes: resumedState.completedNodeIds.length,
              frontierNodes:  resumedState.currentNodeIds,
              message:        `Workflow "${ definition.name }" resumed from last checkpoint. ${ resumedState.completedNodeIds.length } nodes already completed. Continuing from frontier: [${ resumedState.currentNodeIds.join(', ') }].`,
            }, null, 2),
          };
        }
      }
    } catch (err) {
      console.warn(`[ExecuteWorkflow] Checkpoint lookup failed, starting fresh:`, err);
    }
  }

  // Create the playbook state and load it into the agent's metadata
  try {
    const playbook = createPlaybookState(definition, message);

    state.metadata.activeWorkflow = playbook;

    // Verify state propagation
    const verify = state.metadata.activeWorkflow;
    console.log(`[ExecuteWorkflow] Loaded workflow "${ definition.name }" (${ workflowId }) as playbook — executionId=${ playbook.executionId }, frontier=[${ playbook.currentNodeIds.join(', ') }], stateVerify=${ verify?.status }/${ verify?.currentNodeIds?.length ?? 0 }`);

    return {
      ok:             true,
      responseString: JSON.stringify({
        executionId:  playbook.executionId,
        workflowSlug: workflowId,
        workflowName: definition.name,
        status:       'activated',
        message:      `Workflow "${ definition.name }" activated. The workflow orchestration system has taken over. Do not respond further — the playbook will drive all subsequent steps.`,
      }, null, 2),
    };
  } catch (error) {
    return {
      ok:             false,
      responseString: `Error activating workflow "${ workflowId }": ${ (error as Error).message }`,
    };
  }
}

export class ExecuteWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!this.state) {
      return {
        successBoolean: false,
        responseString: 'No agent state available. This tool must be called from within an agent loop.',
      };
    }

    const result = await activateWorkflowOnState(this.state as unknown as BaseThreadState, {
      workflowId:        input.workflowId,
      message:           input.message,
      resume:            input.resume,
      resumeExecutionId: input.resumeExecutionId,
      startNodeId:       input.startNodeId,
    });

    return {
      successBoolean: result.ok,
      responseString: result.responseString,
    };
  }
}
