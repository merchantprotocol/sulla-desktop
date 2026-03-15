import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Get Template Collections Tool - Worker class for execution
 */
export class GetTemplateCollectionsWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const response = await service.getTemplateCollections({
        page:  input.page,
        limit: input.limit,
      });

      // API returns { collections: [...] } wrapper, extract the array
      const collections = Array.isArray(response) ? response : (response?.collections || []);

      if (!collections || collections.length === 0) {
        return {
          successBoolean: false,
          responseString: 'No template collections found.',
        };
      }

      let responseString = `n8n Template Collections (${ collections.length } found):\n\n`;
      collections.forEach((collection: any, index: number) => {
        responseString += `${ index + 1 }. Name: ${ collection.name }\n`;
        responseString += `   ID: ${ collection.id }\n`;
        if (collection.description) {
          responseString += `   Description: ${ collection.description }\n`;
        }
        // Handle workflow array - collections contain workflow IDs
        const workflowCount = collection.workflows?.length || 0;
        if (workflowCount > 0) {
          responseString += `   Workflows: ${ workflowCount } templates\n`;
        }
        responseString += `\n`;
      });

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting template collections: ${ (error as Error).message }`,
      };
    }
  }
}
