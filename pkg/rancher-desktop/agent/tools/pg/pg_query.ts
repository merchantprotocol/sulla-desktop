import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Pg Query Tool - Worker class for execution
 */
export class PgQueryWorker extends BaseTool {
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
      const rawResult = await postgresClient.query(sql, params);
      const rows = Array.isArray(rawResult)
        ? rawResult
        : (rawResult === undefined || rawResult === null ? [] : [rawResult]);
      let rowsJson = '[]';
      try {
        rowsJson = JSON.stringify(rows, null, 2);
      } catch {
        rowsJson = '[unserializable rows]';
      }

      const responseString = `PostgreSQL Query Result:
Rows Returned: ${ rows.length }
Rows: ${ rowsJson }
Query Executed Successfully`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing PostgreSQL query: ${ (error as Error).message }`,
      };
    }
  }
}
