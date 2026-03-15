import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';
import { postgresClient } from '../../database/PostgresClient';

function isVariablesLicenseError(error: Error): boolean {
  const message = error.message || '';
  return message.includes('N8n API error 403') && message.includes('feat:variables');
}

function formatVariableDate(value: unknown): string {
  if (!value) {
    return 'N/A';
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleString();
}

/**
 * Get Variables Tool - Worker class for execution
 */
export class GetVariablesWorker extends BaseTool {
  name = '';
  description = '';

  private async getVariablesFromPostgres(input: any): Promise<any[]> {
    await postgresClient.initialize();

    const limit = Math.min(Number(input.limit ?? 250), 250);
    const stateEmptyOnly = input.state === 'empty';
    const projectId = input.projectId ?? null;

    return postgresClient.query(
      `SELECT id, key, value, "projectId", NULL::text AS "createdAt", NULL::text AS "updatedAt"
       FROM "variables"
       WHERE ($1::text IS NULL OR "projectId" = $1)
         AND ($2::boolean = false OR value IS NULL OR value = '')
       ORDER BY key ASC
       LIMIT $3`,
      [projectId, stateEmptyOnly, limit],
    );
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const variables = await service.getVariables(input);

      if (!variables || variables.length === 0) {
        return {
          successBoolean: false,
          responseString: 'No variables found with the specified filters.',
        };
      }

      let responseString = `n8n Variables (${ variables.length } found):\n\n`;
      variables.forEach((variable: any, index: number) => {
        responseString += `${ index + 1 }. Key: ${ variable.key }\n`;
        responseString += `   Value: ${ variable.value }\n`;
        responseString += `   ID: ${ variable.id }\n`;
        responseString += `   Project ID: ${ variable.projectId || 'Global' }\n`;
        responseString += `   Created: ${ new Date(variable.createdAt).toLocaleString() }\n`;
        responseString += `   Updated: ${ new Date(variable.updatedAt).toLocaleString() }\n\n`;
      });

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      if (error instanceof Error && isVariablesLicenseError(error)) {
        try {
          const variables = await this.getVariablesFromPostgres(input);
          if (!variables || variables.length === 0) {
            return {
              successBoolean: false,
              responseString: 'No variables found with the specified filters (PostgreSQL fallback).',
            };
          }

          let responseString = `n8n Variables (${ variables.length } found, fallback via PostgreSQL):\n\n`;
          variables.forEach((variable: any, index: number) => {
            responseString += `${ index + 1 }. Key: ${ variable.key }\n`;
            responseString += `   Value: ${ variable.value }\n`;
            responseString += `   ID: ${ variable.id }\n`;
            responseString += `   Project ID: ${ variable.projectId || 'Global' }\n`;
            responseString += `   Created: ${ formatVariableDate(variable.createdAt) }\n`;
            responseString += `   Updated: ${ formatVariableDate(variable.updatedAt) }\n\n`;
          });

          return {
            successBoolean: true,
            responseString,
          };
        } catch (fallbackError) {
          return {
            successBoolean: false,
            responseString: `Error getting variables: ${ error.message }. PostgreSQL fallback failed: ${ (fallbackError as Error).message }`,
          };
        }
      }

      return {
        successBoolean: false,
        responseString: `Error getting variables: ${ (error as Error).message }`,
      };
    }
  }
}
