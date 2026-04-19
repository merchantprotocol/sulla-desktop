import { getExtensionService } from '../../services/ExtensionService';
import { BaseTool, ToolResponse } from '../base';

/**
 * List all currently installed extensions.
 */
export class ListInstalledWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const svc = getExtensionService();
      await svc.initialize();
      const installed = await svc.fetchInstalledExtensions();

      if (installed.length === 0) {
        return {
          successBoolean: true,
          responseString: 'No extensions are currently installed.',
        };
      }

      const lines = installed.map(ext => {
        const title = ext.labels?.['org.opencontainers.image.title'] ?? ext.id;
        const urls = ext.extraUrls.map(u => `${ u.label }: ${ u.url }`).join(', ');
        const upgrade = ext.canUpgrade ? ` (upgrade available: v${ ext.availableVersion })` : '';
        return `- **${ title }** (${ ext.id }) v${ ext.version }${ upgrade }${ urls ? ` — URLs: ${ urls }` : '' }`;
      });

      return {
        successBoolean: true,
        responseString: `Installed Extensions (${ installed.length }):\n${ lines.join('\n') }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error fetching installed extensions: ${ (error as Error).message }`,
      };
    }
  }
}
