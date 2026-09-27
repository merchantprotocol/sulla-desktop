import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient, isAuthError, SIGN_IN_HINT } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind, toMarketplaceKind } from './types';

export class MarketplaceUnpublishWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = normalizeKind(input.kind);
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const confirm = input.confirm === true;

    if (!kind) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ KINDS_HELP }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: 'Missing required field: slug.' };
    }
    const mk = toMarketplaceKind(kind);
    if (!mk) {
      return { successBoolean: false, responseString: 'Agents aren\'t distributed through the marketplace.' };
    }
    if (!confirm) {
      return {
        successBoolean: false,
        responseString: `Refusing to unpublish without explicit confirmation. Re-call with {"confirm":true} to remove ${ input.kind }/${ slug } from the marketplace. Local copy is unaffected.`,
      };
    }

    try {
      const client = getMarketplaceClient();
      const mine = await client.mySubmissions();
      // Newest live submission first; rejected rows are already off the marketplace.
      const target = mine
        .filter(t => t.kind === mk && t.slug === slug && t.status !== 'rejected')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

      if (!target) {
        return { successBoolean: false, responseString: `You have no live submission for ${ input.kind }/${ slug }. See \`sulla marketplace/list_published '{}'\`.` };
      }

      const res = await client.takedown(target.id);

      return {
        successBoolean: true,
        responseString: res.action === 'withdrawn'
          ? `Withdrew ${ input.kind }/${ slug } v${ target.version } (${ target.id }) from the marketplace. It stays in your submissions as rejected.`
          : `Deleted the ${ target.status } submission ${ input.kind }/${ slug } v${ target.version } (${ target.id }).`,
      };
    } catch (err) {
      if (isAuthError(err)) return { successBoolean: false, responseString: `Unpublish needs a Sulla Cloud session. ${ SIGN_IN_HINT }` };

      return { successBoolean: false, responseString: `Unpublish failed: ${ (err as Error).message }` };
    }
  }
}
