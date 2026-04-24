import { getExtensionService } from '../../services/ExtensionService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Stop a running extension (recipe). Container stack goes down — web UI
 * and integrations stop responding. Data is preserved on disk.
 *
 * Requires explicit confirmation: most users won't realise stopping kills
 * their CRM / project tracker / etc. and breaks anything depending on it.
 */
export class StopExtensionWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const confirm = input.confirm === true;

    if (!id) {
      return {
        successBoolean: false,
        responseString: 'Extension ID is required. Use list_installed_extensions to see what\'s installed.',
      };
    }

    if (!confirm) {
      return {
        successBoolean: false,
        responseString:
          `Refusing to stop "${ id }" without explicit confirmation. Stopping kills the container ` +
          `stack and breaks anything depending on it (web UI, integrations). Re-call with ` +
          `{"id":"${ id }","confirm":true} to proceed. Data on disk is preserved.`,
      };
    }

    try {
      const svc = getExtensionService();
      await svc.initialize();

      const result = await svc.stopExtension(id);

      if (!result.ok) {
        return {
          successBoolean: false,
          responseString: `Failed to stop ${ id }: ${ result.error }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Stopped extension ${ id }. Use start_extension to bring it back up.`,
      };
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Stop extension failed: ${ (err as Error).message }`,
      };
    }
  }
}
