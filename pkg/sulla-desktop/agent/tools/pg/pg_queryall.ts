// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { postgresClient } from '../../database/PostgresClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Pg Query All Tool - Worker class for execution
 */
export class PgQueryAllWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { sql, params = [] } = input;

    try {
      const result = await postgresClient.queryAll(sql, params);
      const rowsJson = JSON.stringify(result, null, 2);

      const responseString = `PostgreSQL QueryAll Result:
Rows Returned: ${ result.length }
Rows: ${ rowsJson }
Query Executed Successfully`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing PostgreSQL queryAll: ${ (error as Error).message }`,
      };
    }
  }
}
