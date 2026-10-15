import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient, isAuthError, SIGN_IN_HINT } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind } from './types';

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
    if (String(input.kind ?? '').trim().toLowerCase().replace(/s$/, '') === 'package') {
      try {
        const { publishPackage } = await import('@pkg/main/marketplace/publish');
        const items = Array.isArray(input.items) ? input.items : [];
        const result = await publishPackage({
          slug:        String(input.slug ?? '').trim(),
          title:       String(input.title ?? '').trim(),
          description: String(input.description ?? ''),
          topic:       typeof input.topic === 'string' ? input.topic : undefined,
          version:     typeof input.version === 'string' ? input.version : undefined,
          items,
        });
        return { successBoolean: true, responseString: `Submitted package/${ result.slug } as ${ result.templateId } (bundle ${ result.bundle_size } bytes). Status: ${ result.status }.` };
      } catch (err) {
        if (isAuthError(err)) return { successBoolean: false, responseString: `Publishing needs a Sulla Cloud session. ${ SIGN_IN_HINT }` };
        return { successBoolean: false, responseString: `Publish failed: ${ (err as Error).message }` };
      }
    }
    const kind = normalizeKind(input.kind);
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const version = typeof input.version === 'string' && input.version.trim() ? input.version.trim() : undefined;

    if (!kind) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ KINDS_HELP }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: 'Missing required field: slug.' };
    }
    return this.publishFrom(kind, slug, version, input.kind);
  }

  private async publishFrom(kind: NonNullable<ReturnType<typeof normalizeKind>>, slug: string, version: string | undefined, kindLabel: string): Promise<ToolResponse> {
    try {
      const res = await getMarketplaceClient().publish(kind, slug, version);

      return {
        successBoolean: true,
        responseString: `Submitted ${ kindLabel }/${ slug } to the marketplace as ${ res.templateId } (bundle ${ res.bundle_size } bytes).\n` +
          `Status: ${ res.status } — it goes live once an admin approves it. Track it with \`sulla marketplace/list_published '{}'\`.` +
          (res.warnings?.length ? `\nWarning: ${ res.warnings.join(' ') }` : ''),
      };
    } catch (err) {
      if (isAuthError(err)) return { successBoolean: false, responseString: `Publishing needs a Sulla Cloud session. ${ SIGN_IN_HINT }` };

      return { successBoolean: false, responseString: `Publish failed: ${ (err as Error).message }` };
    }
  }
}
