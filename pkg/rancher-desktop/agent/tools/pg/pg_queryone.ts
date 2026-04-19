import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Pg Query One Tool - Worker class for execution
 */
export class PgQueryOneWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { sql, params = [] } = input;

    try {
      const result = await postgresClient.queryOne(sql, params);
      const rowJson = result ? JSON.stringify(result, null, 2) : 'null';

      const responseString = `PostgreSQL QueryOne Result:
Row Returned: ${ result ? 'Yes' : 'No' }
Row: ${ rowJson }
Query Executed Successfully`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing PostgreSQL queryOne: ${ (error as Error).message }`,
      };
    }
  }
}
