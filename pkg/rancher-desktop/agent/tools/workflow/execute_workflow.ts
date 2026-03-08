import { BaseTool, ToolResponse } from '../base';
import { getWorkflowRegistry } from '../../workflow/WorkflowRegistry';
import type { TriggerNodeSubtype } from '@pkg/pages/editor/workflow/types';

export class ExecuteWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { workflowId } = input;

    if (!workflowId) {
      return {
        successBoolean: false,
        responseString: 'workflowId is required. Use list_workflows first to discover available workflows.',
      };
    }

    // Resolve trigger type and message from state
    let triggerType: TriggerNodeSubtype = 'sulla-desktop';
    let message = input.message || '';

    if (this.state) {
      const meta = (this.state as any).metadata;
      const channel = meta?.wsChannel || '';
      const validTriggers: TriggerNodeSubtype[] = [
        'calendar', 'chat-app', 'heartbeat', 'sulla-desktop', 'workbench', 'chat-completions',
      ];
      if (validTriggers.includes(channel as TriggerNodeSubtype)) {
        triggerType = channel as TriggerNodeSubtype;
      }

      // Fall back to the last user message if no explicit message provided
      if (!message) {
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
    }

    if (!message) {
      return {
        successBoolean: false,
        responseString: 'No message available. Provide a message parameter or ensure there is a user message in the conversation.',
      };
    }

    try {
      const registry = getWorkflowRegistry();
      const originChannel = (this.state as any)?.metadata?.wsChannel || undefined;

      const result = await registry.dispatch({
        triggerType,
        message,
        workflowId,
        originChannel,
      });

      if (!result) {
        return {
          successBoolean: false,
          responseString: `Workflow "${workflowId}" not found or could not be dispatched.`,
        };
      }

      // Wait for completion
      const runState = await result.done;

      return {
        successBoolean: runState.status === 'completed',
        responseString: JSON.stringify({
          executionId: result.executionId,
          workflowId: result.workflowId,
          workflowName: result.workflowName,
          status: runState.status,
          error: runState.error || undefined,
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing workflow "${workflowId}": ${(error as Error).message}`,
      };
    }
  }
}
