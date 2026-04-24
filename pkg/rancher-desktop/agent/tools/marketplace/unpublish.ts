import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { isArtifactKind } from './types';

/**
 * Remove an artifact you previously published from the marketplace.
 * Does NOT touch your local copy.
 */
export class MarketplaceUnpublishWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const confirm = input.confirm === true;

    if (!isArtifactKind(kind)) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: skill, function, workflow, agent, recipe, integration.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: `Missing required field: slug.` };
    }
    if (!confirm) {
      return {
        successBoolean: false,
        responseString: `Refusing to unpublish without explicit confirmation. Re-call with {"confirm":true} to remove ${ kind }/${ slug } from the marketplace. Local copy is unaffected.`,
      };
    }

    try {
      await getMarketplaceClient().unpublish(kind, slug);
      return { successBoolean: true, responseString: `Unpublished ${ kind }/${ slug } from the marketplace.` };
    } catch (err) {
      return { successBoolean: false, responseString: `Unpublish failed: ${ (err as Error).message }` };
    }
  }
}
