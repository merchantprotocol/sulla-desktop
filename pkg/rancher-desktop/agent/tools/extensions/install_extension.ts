import { BaseTool, ToolResponse } from '../base';
import { getExtensionService } from '../../services/ExtensionService';

/**
 * Install an extension from the marketplace catalog.
 */
export class InstallExtensionWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { id } = input;

    if (!id) {
      return {
        successBoolean: false,
        responseString: 'Extension ID is required. Use list_extension_catalog to find available extensions.',
      };
    }

    try {
      const svc = getExtensionService();
      await svc.initialize();

      const result = await svc.installExtension(id);

      if (!result.ok) {
        return {
          successBoolean: false,
          responseString: `Failed to install ${ id }: ${ result.error }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Extension ${ id } installed successfully. It has been started automatically.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error installing extension: ${ (error as Error).message }`,
      };
    }
  }
}
