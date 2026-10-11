import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind } from './types';

export class MarketplaceDownloadWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = normalizeKind(input.kind);
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const overwrite = input.overwrite === true;

    if (!kind) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ KINDS_HELP }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: 'Missing required field: slug.' };
    }

    try {
      const { listing, result } = await getMarketplaceClient().install(kind, slug, { overwrite });

      if (result.alreadyInstalled) {
        const outdated = result.version !== listing.version;

        return {
          successBoolean: true,
          responseString: `${ listing.name } is already installed (v${ result.version }) at ${ result.path }.` +
            (outdated ? `\nv${ listing.version } is available — run \`sulla marketplace/update '{"kind":"${ input.kind }","slug":"${ slug }"}'\`.` : ''),
        };
      }

      return {
        successBoolean: true,
        responseString: (result.updated
          ? `Updated ${ listing.name } v${ result.previousVersion } → v${ result.version } at ${ result.path }`
          : `Installed ${ listing.name } v${ result.version } (${ result.kind }) at ${ result.path }`) +
          (result.warnings?.length ? `\nWarning: ${ result.warnings.join('\nWarning: ') }` : ''),
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Marketplace install failed: ${ (err as Error).message }` };
    }
  }
}
