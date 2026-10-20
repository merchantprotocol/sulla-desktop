import { ToolResponse } from '../base';
import { FilesTool, writeUseCaseDraft } from '../files/common';
import { draftResponse } from '../useCaseDraft';
import { getMarketplaceClient } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind } from './types';

export class MarketplaceDownloadWorker extends FilesTool {
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
      const fetched = await getMarketplaceClient().fetchLatest(kind!, slug);
      const { readBundleFiles } = await import('@pkg/main/marketplace/databaseInstaller');
      const files = readBundleFiles(fetched.rootPath) as Record<string, string>;
      const type = kind === 'workflow' ? 'workflows' : `${ kind }s` as 'agents' | 'skills' | 'workflows' | 'functions' | 'recipes';
      try {
        const written = await writeUseCaseDraft(this, input, type, fetched.listing.slug, files);
        return { successBoolean: true, responseString: draftResponse(type, fetched.listing.slug, files, written).responseString };
      } finally {
        fetched.cleanup();
      }
    } catch (err) {
      return { successBoolean: false, responseString: `Marketplace install failed: ${ (err as Error).message }` };
    }
  }
}
