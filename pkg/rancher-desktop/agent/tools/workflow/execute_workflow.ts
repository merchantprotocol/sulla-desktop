import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import { BaseTool, ToolResponse } from '../base';
import { resolveSullaWorkflowsDir } from '@pkg/agent/utils/sullaPaths';
import { createPlaybookState } from '../../workflow/WorkflowPlaybook';
import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';

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
    const scopedWorkflowId = (this.state as any)?.metadata?.scopedWorkflowId;
    if (scopedWorkflowId && workflowId !== scopedWorkflowId) {
      return {
        successBoolean: false,
        responseString: `You can only execute workflow "${scopedWorkflowId}" in this context. Check your available workflows in the system prompt.`,
      };
    }

    // Resolve the trigger message from input or last user message
    let message = input.message || '';

    if (!message && this.state) {
      const messages = (this.state as any).messages;
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

    const yamlPath = path.join(workflowsDir, `${workflowId}.yaml`);
    const jsonPath = path.join(workflowsDir, `${workflowId}.json`);

    try {
      if (fs.existsSync(yamlPath)) {
        definition = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
      } else if (fs.existsSync(jsonPath)) {
        definition = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      }
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Error loading workflow "${workflowId}": ${(err as Error).message}`,
      };
    }

    if (!definition) {
      return {
        successBoolean: false,
        responseString: `Workflow "${workflowId}" not found. Check your available workflows in the system prompt.`,
      };
    }

    // Create the playbook state and load it into the agent's metadata
    try {
      const playbook = createPlaybookState(definition, message);

      if (this.state) {
        (this.state as any).metadata.activeWorkflow = playbook;
      }

      console.log(`[ExecuteWorkflow] Loaded workflow "${definition.name}" (${workflowId}) as playbook — executionId=${playbook.executionId}, frontier=[${playbook.currentNodeIds.join(', ')}]`);

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          executionId: playbook.executionId,
          workflowId:  definition.id,
          workflowName: definition.name,
          status: 'activated',
          message: `Workflow "${definition.name}" activated. The workflow orchestration system has taken over. Do not respond further — the playbook will drive all subsequent steps.`,
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error activating workflow "${workflowId}": ${(error as Error).message}`,
      };
    }
  }
}
