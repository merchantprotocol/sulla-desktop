import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

export class GetCredentialWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const id = String(input.id || '').trim();
      if (!id) {
        return { successBoolean: false, responseString: 'id is required' };
      }

      const service = await createN8nService();
      const credential = await service.getCredential(id);

      if (!credential) {
        return {
          successBoolean: false,
          responseString: `Credential not found: ${ id }`,
        };
      }

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          id:        credential.id ?? null,
          name:      credential.name ?? null,
          type:      credential.type ?? null,
          isManaged: credential.isManaged ?? null,
          isGlobal:  credential.isGlobal ?? null,
          createdAt: credential.createdAt ?? null,
          updatedAt: credential.updatedAt ?? null,
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting credential: ${ (error as Error).message }`,
      };
    }
  }
}
