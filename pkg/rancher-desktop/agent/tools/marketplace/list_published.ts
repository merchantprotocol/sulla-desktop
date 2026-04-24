import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';

/**
 * List artifacts the current user has published to the marketplace.
 * Hits GET /v1/marketplace/me/published — requires Sulla Cloud token.
 */
export class MarketplaceListPublishedWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const items = await getMarketplaceClient().myPublished();
      if (items.length === 0) {
        return { successBoolean: true, responseString: `You haven't published any artifacts yet.` };
      }
      const lines = items.map(i => `  - ${ i.kind }/${ i.slug }${ i.version ? ` v${ i.version }` : '' }${ i.updated_at ? ` (updated ${ i.updated_at })` : '' }`);
      return {
        successBoolean: true,
        responseString: `Your published artifacts (${ items.length }):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (/HTTP 401|HTTP 403/.test(msg)) {
        return { successBoolean: false, responseString: `Not authenticated. Set Sulla Cloud token: \`sulla vault/vault_set_credential '{"account_type":"sulla-cloud","property":"api_token","value":"..."}'\`` };
      }
      return { successBoolean: false, responseString: `Failed to list published artifacts: ${ msg }` };
    }
  }
}
