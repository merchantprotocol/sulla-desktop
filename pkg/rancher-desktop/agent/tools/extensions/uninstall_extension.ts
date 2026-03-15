import { BaseTool, ToolResponse } from '../base';
import { getExtensionService } from '../../services/ExtensionService';

/**
 * Uninstall an extension. By default preserves the data/ directory.
 */
export class UninstallExtensionWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { id, deleteData } = input;

    if (!id) {
      return {
        successBoolean: false,
        responseString: 'Extension ID is required. Use list_installed_extensions to see installed extensions.',
      };
    }

    try {
      const svc = getExtensionService();
      await svc.initialize();

      const result = await svc.uninstallExtension(id, { deleteData: deleteData === true });

      if (!result.ok) {
        return {
          successBoolean: false,
          responseString: `Failed to uninstall ${ id }: ${ result.error }`,
        };
      }

      const dataNote = deleteData ? ' All data was deleted.' : ' The data/ directory was preserved.';

      return {
        successBoolean: true,
        responseString: `Extension ${ id } uninstalled successfully.${ dataNote }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error uninstalling extension: ${ (error as Error).message }`,
      };
    }
  }
}
