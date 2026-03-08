import { BaseTool, ToolResponse } from '../base';
import { getWorkflowRegistry } from '../../workflow/WorkflowRegistry';
import type { TriggerNodeSubtype } from '@pkg/pages/editor/workflow/types';

export class ListWorkflowsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    // Resolve trigger type: explicit param > agent state wsChannel > fallback
    let triggerType: TriggerNodeSubtype | undefined = input.triggerType;

    if (!triggerType && this.state) {
      const channel = (this.state as any).metadata?.wsChannel || '';
      const validTriggers: TriggerNodeSubtype[] = [
        'calendar', 'chat-app', 'heartbeat', 'sulla-desktop', 'workbench', 'chat-completions',
      ];
      if (validTriggers.includes(channel as TriggerNodeSubtype)) {
        triggerType = channel as TriggerNodeSubtype;
      }
    }

    if (!triggerType) {
      return {
        successBoolean: false,
        responseString: 'Could not determine trigger type. Pass triggerType explicitly or ensure agent state has a valid wsChannel.',
      };
    }

    try {
      const registry = getWorkflowRegistry();
      const candidates = registry.findCandidates(triggerType);

      if (candidates.length === 0) {
        return {
          successBoolean: true,
          responseString: `No workflows found for trigger type "${triggerType}".`,
        };
      }

      const list = candidates.map(c => ({
        slug: c.definition.id,
        name: c.definition.name,
        description: c.triggerDescription || c.definition.description || c.definition.name,
      }));

      return {
        successBoolean: true,
        responseString: JSON.stringify({ triggerType, workflows: list }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error listing workflows: ${(error as Error).message}`,
      };
    }
  }
}
