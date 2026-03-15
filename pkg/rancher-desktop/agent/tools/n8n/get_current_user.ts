import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Get Current User Tool - Worker class for execution
 */
export class GetCurrentUserWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const user = await service.getCurrentUser();

      const responseString = `Current n8n User:
ID: ${ user.id }
Email: ${ user.email }
First Name: ${ user.firstName }
Last Name: ${ user.lastName }
Full Name: ${ user.firstName } ${ user.lastName }
Role: ${ user.role }
Created: ${ new Date(user.createdAt).toLocaleString() }
Updated: ${ new Date(user.updatedAt).toLocaleString() }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting current user: ${ (error as Error).message }`,
      };
    }
  }
}
