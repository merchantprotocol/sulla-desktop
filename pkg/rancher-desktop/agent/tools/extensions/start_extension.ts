import { getExtensionService } from '../../services/ExtensionService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Start a previously-installed extension (recipe). The container stack
 * comes back up; web UIs and integrations become reachable again.
 */
export class StartExtensionWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';

    if (!id) {
      return {
        successBoolean: false,
        responseString: 'Extension ID is required. Use list_installed_extensions to see what\'s installed.',
      };
    }

    try {
      const svc = getExtensionService();
      await svc.initialize();

      const result = await svc.startExtension(id);

      if (!result.ok) {
        return {
          successBoolean: false,
          responseString: `Failed to start ${ id }: ${ result.error }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Started extension ${ id }. Use list_installed_extensions to confirm status.`,
      };
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Start extension failed: ${ (err as Error).message }`,
      };
    }
  }
}
