import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

export class SetWorkflowActiveWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const workflowId = String(input.workflowId || '').trim();
      if (!workflowId) {
        throw new Error('workflowId is required.');
      }

      const active = input.active === true;
      const service = await createN8nService();

      let result: any;
      if (active) {
        const versionId = typeof input.versionId === 'string' && input.versionId.trim()
          ? input.versionId.trim()
          : undefined;
        result = await service.activateWorkflow(workflowId, versionId ? { versionId } : undefined);
      } else {
        result = await service.deactivateWorkflow(workflowId);
      }

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          workflowId,
          active,
          result:    result ?? null,
          toggledAt: new Date().toISOString(),
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error toggling workflow active state: ${ (error as Error).message }`,
      };
    }
  }
}
