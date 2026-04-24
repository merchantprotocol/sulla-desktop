import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { isArtifactKind } from './types';

export class MarketplaceSearchWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kindRaw = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    if (kindRaw && !isArtifactKind(kindRaw)) {
      return { successBoolean: false, responseString: `Invalid kind "${ kindRaw }". Must be one of: skill, function, workflow, agent, recipe, integration.` };
    }

    try {
      const results = await getMarketplaceClient().search({
        query:    typeof input.query === 'string' ? input.query : undefined,
        kind:     kindRaw || undefined,
        category: typeof input.category === 'string' ? input.category : undefined,
        limit:    typeof input.limit === 'number' ? input.limit : 25,
      });

      if (results.length === 0) {
        return { successBoolean: true, responseString: `No marketplace artifacts matched the query.` };
      }

      const lines = results.map(r => {
        const tag = r.tags && r.tags.length > 0 ? ` [${ r.tags.slice(0, 3).join(', ') }]` : '';
        const ver = r.version ? ` v${ r.version }` : '';
        const desc = r.description ? `\n     ${ r.description.slice(0, 200) }${ r.description.length > 200 ? '…' : '' }` : '';
        return `- ${ r.kind }/${ r.slug }${ ver } — ${ r.name || r.slug }${ tag }${ desc }`;
      });

      return {
        successBoolean: true,
        responseString: `Found ${ results.length } marketplace result(s):\n${ lines.join('\n') }\n\nFor full info: \`sulla marketplace/info '{"kind":"<kind>","slug":"<slug>"}'\``,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Marketplace search failed: ${ (err as Error).message }` };
    }
  }
}
