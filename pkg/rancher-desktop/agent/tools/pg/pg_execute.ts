import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Pg Execute Tool - Worker class for execution
 */
export class PgExecuteWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const sql = String(input.sql ?? input.query ?? input.statement ?? '').trim();
    const params = Array.isArray(input.params) ? input.params : [];

    if (!sql) {
      return {
        successBoolean: false,
        responseString: 'Missing SQL statement. Provide sql (preferred) or query/statement.',
      };
    }

    try {
      const res = await postgresClient.queryWithResult(sql, params);
      const rowsJson = JSON.stringify(res.rows ?? [], null, 2);

      const responseString = `PostgreSQL Execution Result:
Command: ${ res.command }
Rows Affected: ${ res.rowCount }
Rows: ${ rowsJson }
OID: ${ res.oid || 'N/A' }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing PostgreSQL statement: ${ (error as Error).message }`,
      };
    }
  }
}
