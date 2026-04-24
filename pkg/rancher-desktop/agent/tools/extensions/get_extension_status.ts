import { getExtensionService } from '../../services/ExtensionService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Check whether an installed extension is currently running, stopped,
 * or not installed at all. Use before start/stop to avoid surprises.
 */
export class GetExtensionStatusWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';

    if (!id) {
      return {
        successBoolean: false,
        responseString: 'Extension ID is required.',
      };
    }

    try {
      const svc = getExtensionService();
      await svc.initialize();

      const status = await svc.getExtensionStatus(id);

      return {
        successBoolean: true,
        responseString: `Extension ${ id } status: ${ status }`,
      };
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Status check failed: ${ (err as Error).message }`,
      };
    }
  }
}
