import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Health Check Tool - Worker class for execution
 */
export class HealthCheckWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const health = await service.healthCheck();

      if (health) {
        return {
          successBoolean: true,
          responseString: `n8n Health Status: Healthy - API is accessible and responding`,
        };
      } else {
        return {
          successBoolean: false,
          responseString: `n8n Health Status: Unhealthy - API is not accessible or not responding`,
        };
      }
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error checking n8n health: ${ (error as Error).message }`,
      };
    }
  }
}
