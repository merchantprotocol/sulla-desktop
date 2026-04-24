import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { isArtifactKind } from './types';

export class MarketplaceInfoWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

    if (!isArtifactKind(kind)) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: skill, function, workflow, agent, recipe.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: `Missing required field: slug.` };
    }

    try {
      const info = await getMarketplaceClient().info(kind, slug);
      return {
        successBoolean: true,
        responseString: `**${ info.name || info.slug }** (${ info.kind }/${ info.slug })${ info.version ? ` v${ info.version }` : '' }\n\n` +
          (info.description ? `${ info.description }\n\n` : '') +
          (info.publisher ? `Publisher: ${ info.publisher }\n` : '') +
          (info.tags && info.tags.length > 0 ? `Tags: ${ info.tags.join(', ') }\n` : '') +
          (info.updated_at ? `Updated: ${ info.updated_at }\n` : '') +
          `\nMetadata:\n\`\`\`json\n${ JSON.stringify(info.metadata, null, 2) }\n\`\`\``,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Marketplace info failed: ${ (err as Error).message }` };
    }
  }
}
