import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Create Credential Tool - Worker class for execution
 */
export class CreateCredentialWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const credential = await service.createCredential(input);

      const responseString = `Credential created successfully:
ID: ${ credential.id }
Name: ${ credential.name }
Type: ${ credential.type }
Created: ${ new Date(credential.createdAt).toLocaleString() }
Updated: ${ new Date(credential.updatedAt).toLocaleString() }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error creating credential: ${ (error as Error).message }`,
      };
    }
  }
}
