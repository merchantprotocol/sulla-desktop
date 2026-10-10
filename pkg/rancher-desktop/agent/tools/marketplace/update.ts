import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind } from './types';

/**
 * Pull the latest version of an installed artifact from the marketplace,
 * replacing the local copy in place (rolled back if the update fails).
 */
export class MarketplaceUpdateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = normalizeKind(input.kind);
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

    if (!kind) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ KINDS_HELP }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: 'Missing required field: slug.' };
    }

    try {
      const client = getMarketplaceClient();
      const listing = await client.resolve(kind, slug);
      if (!listing) {
        return { successBoolean: false, responseString: `No approved marketplace listing for ${ input.kind }/${ slug }.` };
      }
      if (!listing.installed) {
        return {
          successBoolean: false,
          responseString: `${ input.kind }/${ slug } isn't installed from the marketplace. Use \`sulla marketplace/download '{"kind":"${ input.kind }","slug":"${ slug }"}'\` instead.`,
        };
      }
      if (listing.installed.templateId === listing.id && listing.installed.version === listing.version) {
        return { successBoolean: true, responseString: `${ listing.name } is already up to date (v${ listing.version }) at ${ listing.installed.path }.` };
      }

      const { result } = await client.install(kind, slug, { overwrite: true });

      return {
        successBoolean: true,
        responseString: `Updated ${ listing.name } v${ result.previousVersion ?? listing.installed.version } → v${ result.version } at ${ result.path }` +
          (result.warnings?.length ? `\nWarning: ${ result.warnings.join('\nWarning: ') }` : ''),
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Marketplace update failed: ${ (err as Error).message }` };
    }
  }
}
