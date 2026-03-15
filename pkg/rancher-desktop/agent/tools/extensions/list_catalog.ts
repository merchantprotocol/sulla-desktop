import { BaseTool, ToolResponse } from '../base';
import { getExtensionService } from '../../services/ExtensionService';

/**
 * List all available extensions from the Sulla marketplace catalog.
 */
export class ListCatalogWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { category, query } = input;

    try {
      const svc = getExtensionService();
      await svc.initialize();
      const catalog = await svc.fetchMarketplaceData();

      let results = catalog;

      if (category) {
        results = results.filter(ext => {
          const cats = ext.labels?.['com.docker.extension.categories']?.split(',').map(c => c.trim()) ?? [];
          return cats.some(c => c.toLowerCase().includes(category.toLowerCase()));
        });
      }

      if (query) {
        const q = query.toLowerCase();
        results = results.filter(ext => {
          const hay = `${ ext.title } ${ ext.short_description } ${ ext.publisher } ${ ext.slug }`.toLowerCase();
          return hay.includes(q);
        });
      }

      if (results.length === 0) {
        return {
          successBoolean: true,
          responseString: 'No extensions found matching the criteria.',
        };
      }

      const lines = results.map(ext => {
        const cats = ext.labels?.['com.docker.extension.categories'] ?? '';
        return `- **${ ext.title }** (${ ext.slug }) v${ ext.version } — ${ ext.short_description } [${ cats }]`;
      });

      return {
        successBoolean: true,
        responseString: `Available Extensions (${ results.length }):\n${ lines.join('\n') }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error fetching catalog: ${ (error as Error).message }`,
      };
    }
  }
}
