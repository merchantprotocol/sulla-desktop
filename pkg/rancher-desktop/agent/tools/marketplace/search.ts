import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient, MarketplaceListing } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind } from './types';

export function formatListingLine(r: MarketplaceListing): string {
  const kind = r.kind === 'workflow' ? 'routine' : r.kind;
  const installed = r.installed
    ? (r.installed.templateId === r.id && r.installed.version === r.version ? ' [installed]' : ` [installed v${ r.installed.version } — update available]`)
    : '';
  const by = r.author ? ` by ${ r.author }` : '';
  const desc = r.description ? `\n     ${ r.description.slice(0, 200) }${ r.description.length > 200 ? '…' : '' }` : '';

  return `- ${ kind }/${ r.slug } v${ r.version } — ${ r.name }${ by } · ${ r.downloads } downloads${ installed }${ desc }`;
}

export class MarketplaceSearchWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kindRaw = typeof input.kind === 'string' ? input.kind.trim() : '';
    const kind = kindRaw ? normalizeKind(kindRaw) : null;
    if (kindRaw && !kind) {
      return { successBoolean: false, responseString: `Invalid kind "${ kindRaw }". Must be one of: ${ KINDS_HELP }.` };
    }
    if (kind === 'agent') {
      return { successBoolean: false, responseString: 'Agents aren\'t distributed through the marketplace. Marketplace kinds: skill, function, routine, recipe, integration.' };
    }

    try {
      const { listings, total } = await getMarketplaceClient().search({
        query:    typeof input.query === 'string' ? input.query : undefined,
        kind:     kind ?? undefined,
        category: typeof input.category === 'string' ? input.category : undefined,
        limit:    typeof input.limit === 'number' ? input.limit : 25,
      });

      if (listings.length === 0) {
        return { successBoolean: true, responseString: 'No marketplace listings matched the query.' };
      }

      const more = total > listings.length ? ` (showing ${ listings.length } of ${ total }; raise "limit" or narrow the query)` : '';

      return {
        successBoolean: true,
        responseString: `Found ${ total } marketplace listing(s)${ more }:\n${ listings.map(formatListingLine).join('\n') }\n\n` +
          'Details: `sulla marketplace/info \'{"kind":"<kind>","slug":"<slug>"}\'` · Install: `sulla marketplace/download \'{"kind":"<kind>","slug":"<slug>"}\'`',
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Marketplace search failed: ${ (err as Error).message }` };
    }
  }
}
