import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Get Tags Tool - Worker class for execution
 */
export class GetTagsWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const tags = await service.getTags();

      if (!tags || tags.length === 0) {
        return {
          successBoolean: false,
          responseString: 'No tags found in n8n.',
        };
      }

      let responseString = `n8n Tags (${ tags.length } total):\n\n`;
      tags.forEach((tag: any, index: number) => {
        responseString += `${ index + 1 }. Name: ${ tag.name }\n`;
        responseString += `   ID: ${ tag.id }\n`;
        responseString += `   Usage Count: ${ tag.usageCount || 'N/A' }\n`;
        responseString += `   Created: ${ tag.createdAt ? new Date(tag.createdAt).toLocaleString() : 'N/A' }\n`;
        responseString += `   Updated: ${ tag.updatedAt ? new Date(tag.updatedAt).toLocaleString() : 'N/A' }\n\n`;
      });

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting tags: ${ (error as Error).message }`,
      };
    }
  }
}
