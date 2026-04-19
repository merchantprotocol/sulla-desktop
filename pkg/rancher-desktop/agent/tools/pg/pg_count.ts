import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Pg Count Tool - Worker class for execution
 */
export class PgCountWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { sql, params = [] } = input;

    try {
      const res = await postgresClient.queryOne<{ count: string }>(sql, params);
      const count = res ? parseInt(res.count, 10) : 0;

      return {
        successBoolean: true,
        responseString: `PostgreSQL Count Result: ${ count }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing PostgreSQL count query: ${ (error as Error).message }`,
      };
    }
  }
}
