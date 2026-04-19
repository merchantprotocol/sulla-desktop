import { createPlaybookState } from '../../workflow/WorkflowPlaybook';
import { BaseTool, ToolResponse } from '../base';

import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';

import type { WorkflowPlaybookState } from '../../workflow/types';

export class ExecuteWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { workflowId } = input;

    if (!workflowId) {
      return {
        successBoolean: false,
        responseString: 'workflowId is required. Pass the workflow slug (filename without extension) from your system prompt.',
      };
    }

    // If scoped to a specific workflow (e.g. from workflow editor), enforce it.
    // The scope may be an internal ID (e.g. "workflow-1773725042351") while the
    // user passes a slug (e.g. "daily-planning"), so resolve both ways.
    const scopedWorkflowId = (this.state)?.metadata?.scopedWorkflowId;
    if (scopedWorkflowId && workflowId !== scopedWorkflowId) {
      // Try resolving the user's input to see if it maps to the scoped workflow
      let matches = false;
      try {
        const { getWorkflowRegistry } = await import('../../workflow/WorkflowRegistry');
        const resolved = getWorkflowRegistry().loadWorkflow(workflowId);
        matches = resolved.id === scopedWorkflowId;
      } catch { /* not found — doesn't match */ }
      if (!matches) {
        return {
          successBoolean: false,
          responseString: `You can only execute workflow "${ scopedWorkflowId }" in this context. Check your available workflows in the system prompt.`,
        };
      }
    }

    // Resolve the trigger message from input or last user message
    let message = input.message || '';

    if (!message && this.state) {
      const messages = (this.state).messages;
      if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user' && messages[i].content) {
            message = messages[i].content;
            break;
          }
        }
      }
    }

    if (!message) {
      return {
        successBoolean: false,
        responseString: 'No message available. Provide a message parameter or ensure there is a user message in the conversation.',
      };
    }

    // Load the workflow definition via the registry (scans production dir)
    let definition: WorkflowDefinition | null = null;

    try {
      const { getWorkflowRegistry } = await import('../../workflow/WorkflowRegistry');
      const registry = getWorkflowRegistry();
      definition = registry.loadWorkflow(workflowId);
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Workflow "${ workflowId }" not found. Use the slug shown in your system prompt (the filename without extension, e.g. "ask-date-time").`,
      };
    }

    // Enforce trigger-type gating: if the caller has a wsChannel that maps to a
    // specific trigger type, only allow workflows that have a matching trigger node.
    // This prevents heartbeat agents from executing schedule-only workflows, etc.
    const wsChannel = (this.state)?.metadata?.wsChannel as string | undefined;
    const gatedTriggers = ['heartbeat', 'calendar', 'schedule'];
    if (wsChannel && gatedTriggers.includes(wsChannel)) {
      const hasTrigger = (definition.nodes || []).some(
        (node: any) => node.data?.category === 'trigger' && node.data?.subtype === wsChannel,
      );
      if (!hasTrigger) {
        return {
          successBoolean: false,
          responseString: `Workflow "${ workflowId }" does not have a "${ wsChannel }" trigger. You can only execute workflows that match your trigger type. Check your available workflows in the system prompt.`,
        };
      }
    }

    // Only resume from checkpoint if explicitly requested
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

            if (this.state) {
              (this.state).metadata.activeWorkflow = resumedState;
            }

            console.log(`[ExecuteWorkflow] Resuming workflow "${ definition.name }" from checkpoint — original=${ savedState.executionId }, new=${ resumedState.executionId }, completed=${ resumedState.completedNodeIds.length } nodes, frontier=[${ resumedState.currentNodeIds.join(', ') }]`);

            return {
              successBoolean: true,
              responseString: JSON.stringify({
                executionId:      resumedState.executionId,
                originalExecId:   savedState.executionId,
                workflowSlug:     workflowId,
                workflowName:     definition.name,
                status:           'resumed',
                completedNodes:   resumedState.completedNodeIds.length,
                frontierNodes:    resumedState.currentNodeIds,
                message:          `Workflow "${ definition.name }" resumed from last checkpoint. ${ resumedState.completedNodeIds.length } nodes already completed. Continuing from frontier: [${ resumedState.currentNodeIds.join(', ') }].`,
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

      if (this.state) {
        (this.state).metadata.activeWorkflow = playbook;
      }

      // Verify state propagation
      const verify = (this.state)?.metadata?.activeWorkflow;
      console.log(`[ExecuteWorkflow] Loaded workflow "${ definition.name }" (${ workflowId }) as playbook — executionId=${ playbook.executionId }, frontier=[${ playbook.currentNodeIds.join(', ') }], stateVerify=${ verify?.status }/${ verify?.currentNodeIds?.length ?? 0 }`);

      return {
        successBoolean: true,
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
        successBoolean: false,
        responseString: `Error activating workflow "${ workflowId }": ${ (error as Error).message }`,
      };
    }
  }
}
