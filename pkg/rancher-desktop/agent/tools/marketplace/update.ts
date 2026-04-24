import * as fs from 'fs';

import { BaseTool, ToolResponse } from '../base';
import { MarketplaceDownloadWorker } from './download';
import { artifactDir, isArtifactKind } from './types';

/**
 * Update a locally-installed artifact to the latest marketplace version.
 * Equivalent to download with overwrite:true, but only when something is already installed.
 */
export class MarketplaceUpdateWorker extends BaseTool {
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

    const dir = artifactDir(kind, slug);
    if (!fs.existsSync(dir)) {
      return {
        successBoolean: false,
        responseString: `${ kind }/${ slug } isn't installed. Use \`sulla marketplace/download '{"kind":"${ kind }","slug":"${ slug }"}'\` instead.`,
      };
    }

    const downloader = new MarketplaceDownloadWorker();
    // BaseTool's public path is `_validatedCall` — invoke directly with the same args + overwrite.
    return await downloader['_validatedCall']({ kind, slug, overwrite: true });
  }
}
