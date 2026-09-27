import * as fs from 'fs';

import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient, isAuthError, SIGN_IN_HINT } from './MarketplaceClient';
import { artifactDir, KINDS_HELP, KIND_LAYOUTS, normalizeKind, resolveArtifactManifestPath, toMarketplaceKind } from './types';

/**
 * Publish a local artifact folder to the marketplace using the same pipeline
 * as the Library's Publish button: sulla/v3 manifest + zip of publishable
 * files (no .env, .git, node_modules…) → submit → bundle upload. The listing
 * is pending until an admin approves it.
 */
export class MarketplacePublishWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = normalizeKind(input.kind);
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const version = typeof input.version === 'string' && input.version.trim() ? input.version.trim() : undefined;

    if (!kind) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ KINDS_HELP }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: 'Missing required field: slug.' };
    }
    if (!toMarketplaceKind(kind)) {
      return { successBoolean: false, responseString: 'Agents aren\'t distributed through the marketplace.' };
    }

    const dir = artifactDir(kind, slug);
    if (!fs.existsSync(dir)) {
      return { successBoolean: false, responseString: `Not found locally: ${ dir }` };
    }
    if (KIND_LAYOUTS[kind].manifest !== 'dynamic' && !resolveArtifactManifestPath(kind, slug)) {
      return { successBoolean: false, responseString: `${ KIND_LAYOUTS[kind].manifest } missing in ${ dir } — run \`sulla marketplace/validate\` first.` };
    }

    try {
      const res = await getMarketplaceClient().publish(kind, dir, slug, version);

      return {
        successBoolean: true,
        responseString: `Submitted ${ input.kind }/${ slug } to the marketplace as ${ res.templateId } (bundle ${ res.bundle_size } bytes).\n` +
          `Status: ${ res.status } — it goes live once an admin approves it. Track it with \`sulla marketplace/list_published '{}'\`.`,
      };
    } catch (err) {
      if (isAuthError(err)) return { successBoolean: false, responseString: `Publishing needs a Sulla Cloud session. ${ SIGN_IN_HINT }` };

      return { successBoolean: false, responseString: `Publish failed: ${ (err as Error).message }` };
    }
  }
}
