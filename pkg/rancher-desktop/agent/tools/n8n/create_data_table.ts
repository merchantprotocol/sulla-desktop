import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Create Data Table Tool - Worker class for execution
 */
export class CreateDataTableWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const dataTable = await service.createDataTable(input);

      const columnsStr = input.columns.map((col: any) => `${ col.name } (${ col.type })`).join(', ');
      const responseString = `Data table created successfully:
ID: ${ dataTable.id }
Name: ${ dataTable.name }
Columns: ${ columnsStr }
Created: ${ new Date(dataTable.createdAt).toLocaleString() }
Updated: ${ new Date(dataTable.updatedAt).toLocaleString() }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error creating data table: ${ (error as Error).message }`,
      };
    }
  }
}
