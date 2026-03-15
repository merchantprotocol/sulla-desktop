import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * List Credentials Tool - Worker class for execution
 */
export class ListCredentialsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const allCredentials = await service.getCredentials(input);
      const requestedType = String(input.type || '').trim().toLowerCase();
      const result = requestedType
        ? allCredentials.filter((cred: any) => String(cred?.type || '').trim().toLowerCase() === requestedType)
        : allCredentials;

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          count:       result.length,
          filter:      requestedType || null,
          credentials: result.map((cred: any) => ({
            id:        cred?.id ?? null,
            name:      cred?.name ?? null,
            type:      cred?.type ?? null,
            isManaged: cred?.isManaged ?? null,
            isGlobal:  cred?.isGlobal ?? null,
          })),
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error listing credentials: ${ (error as Error).message }`,
      };
    }
  }
}
