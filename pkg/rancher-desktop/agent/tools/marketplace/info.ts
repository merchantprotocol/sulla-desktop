import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind } from './types';

export class MarketplaceInfoWorker extends BaseTool {
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
      const { listing: l, manifest } = await getMarketplaceClient().info(kind, slug);
      const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
      const summaryKey = Object.keys(manifest).find(k => k.endsWith('Summary'));
      const kindLabel = l.kind === 'workflow' ? 'routine' : l.kind;
      const installed = l.installed
        ? `Installed: v${ l.installed.version } at ${ l.installed.path }${ l.installed.templateId === l.id && l.installed.version === l.version ? '' : ' — update available (marketplace/update)' }\n`
        : 'Installed: no\n';

      return {
        successBoolean: true,
        responseString: `**${ l.name }** (${ kindLabel }/${ l.slug }) v${ l.version }\n\n` +
          (l.tagline ? `${ l.tagline }\n\n` : '') +
          (l.description ? `${ l.description }\n\n` : '') +
          `Template id: ${ l.id }\n` +
          (l.author ? `Author: ${ l.author }\n` : '') +
          (l.category ? `Category: ${ l.category }\n` : '') +
          (l.tags.length > 0 ? `Tags: ${ l.tags.join(', ') }\n` : '') +
          `Downloads: ${ l.downloads }\n` +
          (l.bundleSize ? `Bundle size: ${ l.bundleSize } bytes\n` : '') +
          (l.updatedAt ? `Updated: ${ l.updatedAt }\n` : '') +
          installed +
          `\nMetadata:\n\`\`\`json\n${ JSON.stringify(metadata, null, 2) }\n\`\`\`` +
          (summaryKey ? `\n${ summaryKey }:\n\`\`\`json\n${ JSON.stringify(manifest[summaryKey], null, 2) }\n\`\`\`` : ''),
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Marketplace info failed: ${ (err as Error).message }` };
    }
  }
}
