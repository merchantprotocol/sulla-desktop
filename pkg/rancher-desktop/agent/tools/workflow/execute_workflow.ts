import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import { BaseTool, ToolResponse } from '../base';
import { resolveSullaWorkflowsDir } from '@pkg/agent/utils/sullaPaths';
import { createPlaybookState } from '../../workflow/WorkflowPlaybook';
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
        responseString: 'workflowId is required. Check your available workflows in the system prompt.',
      };
    }

    // If scoped to a specific workflow (e.g. from workflow editor), enforce it
    const scopedWorkflowId = (this.state)?.metadata?.scopedWorkflowId;
    if (scopedWorkflowId && workflowId !== scopedWorkflowId) {
      return {
        successBoolean: false,
        responseString: `You can only execute workflow "${ scopedWorkflowId }" in this context. Check your available workflows in the system prompt.`,
      };
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

    // Load the workflow definition from disk
    const workflowsDir = resolveSullaWorkflowsDir();
    let definition: WorkflowDefinition | null = null;

    const yamlPath = path.join(workflowsDir, `${ workflowId }.yaml`);
    const jsonPath = path.join(workflowsDir, `${ workflowId }.json`);

    try {
      if (fs.existsSync(yamlPath)) {
        definition = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
      } else if (fs.existsSync(jsonPath)) {
        definition = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      }
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Error loading workflow "${ workflowId }": ${ (err as Error).message }`,
      };
    }

    if (!definition) {
      return {
        successBoolean: false,
        responseString: `Workflow "${ workflowId }" not found. Check your available workflows in the system prompt.`,
      };
    }

    // Auto-resume from last checkpoint if available
    const forceNew = input.forceNew === true;

    if (!forceNew) {
      try {
        const { WorkflowCheckpointModel } = await import('../../database/models/WorkflowCheckpointModel');
        const recentExecs = await WorkflowCheckpointModel.recentExecutions(workflowId, 1);

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
                workflowId:       definition.id,
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

      console.log(`[ExecuteWorkflow] Loaded workflow "${ definition.name }" (${ workflowId }) as playbook — executionId=${ playbook.executionId }, frontier=[${ playbook.currentNodeIds.join(', ') }]`);

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          executionId:  playbook.executionId,
          workflowId:   definition.id,
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
