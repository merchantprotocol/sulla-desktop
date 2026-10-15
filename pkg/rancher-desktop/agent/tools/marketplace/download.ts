import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind } from './types';

export class MarketplaceDownloadWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const rawKind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const kind = normalizeKind(input.kind);
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const overwrite = input.overwrite === true;

    if (!kind && rawKind !== 'package') {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ KINDS_HELP }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: 'Missing required field: slug.' };
    }

    try {
      if (rawKind === 'package') {
        const { findTemplateBySlug } = await import('@pkg/main/marketplace/client');
        const { installTemplate } = await import('@pkg/main/marketplace/install');
        const listing = await findTemplateBySlug('package', slug);
        if (!listing) return { successBoolean: false, responseString: `Package not found: ${ slug }` };
        const result = await installTemplate(listing.id, { overwrite });
        return {
          successBoolean: true,
          responseString: `Installed package ${ listing.name } v${ result.version } in Postgres.${ result.warnings?.length ? `\n${ result.warnings.join('\n') }` : '' }`,
        };
      }
      const { listing, result } = await getMarketplaceClient().install(kind!, slug, { overwrite });

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
