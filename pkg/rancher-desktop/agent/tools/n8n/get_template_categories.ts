import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Get Template Categories Tool - Worker class for execution
 */
export class GetTemplateCategoriesWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const response = await service.getTemplateCategories();

      // API returns { categories: [...] } wrapper, extract the array
      const categories = Array.isArray(response) ? response : (response?.categories || []);

      if (!categories || categories.length === 0) {
        return {
          successBoolean: false,
          responseString: 'No template categories found.',
        };
      }

      let responseString = `n8n Template Categories (${ categories.length } found):\n\n`;
      categories.forEach((category: any, index: number) => {
        const displayName = category.displayName || category.name;
        const icon = category.icon || '';
        const parentInfo = category.parent ? ` (Parent: ${ category.parent.name })` : '';
        responseString += `${ index + 1 }. ${ icon } ${ displayName }${ parentInfo }\n`;
        responseString += `   ID: ${ category.id }\n`;
        if (category.description) {
          responseString += `   Description: ${ category.description }\n`;
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
        responseString: `Error getting template categories: ${ (error as Error).message }`,
      };
    }
  }
}
