import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Create Variable Tool - Worker class for execution
 */
export class CreateVariableWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const variable = await service.createVariable(input);

      const responseString = `Variable created successfully:
ID: ${ variable.id }
Key: ${ variable.key }
Value: ${ variable.value }
Project ID: ${ variable.projectId || 'Global' }
Created: ${ new Date(variable.createdAt).toLocaleString() }
Updated: ${ new Date(variable.updatedAt).toLocaleString() }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error creating variable: ${ (error as Error).message }`,
      };
    }
  }
}
