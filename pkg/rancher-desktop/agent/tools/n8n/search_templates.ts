import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

/**
 * Search Templates Tool - Worker class for execution
 */
export class SearchTemplatesWorker extends BaseTool {
  name = '';
  description = '';

  private getTemplatesFromResult(result: any): any[] {
    if (Array.isArray(result?.workflows)) {
      return result.workflows;
    }

    if (Array.isArray(result?.templates)) {
      return result.templates;
    }

    return [];
  }

  private getTotalCountFromResult(result: any, templates: any[]): number {
    const totalCount = Number(result?.totalWorkflows ?? result?.totalCount ?? templates.length ?? 0);

    if (Number.isFinite(totalCount) && totalCount >= 0) {
      return totalCount;
    }

    return templates.length;
  }

  private buildFallbackSearchTerms(search: string): string[] {
    const trimmed = search.trim();
    const candidates: string[] = [];
    const seen = new Set<string>();

    const addCandidate = (value: string) => {
      const normalized = value.trim().replace(/\s+/g, ' ');
      if (!normalized) {
        return;
      }

      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      candidates.push(normalized);
    };

    const phraseParts = trimmed
      .split(/\s*(?:,|;|\||\/|\band\b|\bor\b)\s*/i)
      .map((part: string) => part.trim())
      .filter(Boolean);

    for (const phrase of phraseParts) {
      addCandidate(phrase);
    }

    const words = trimmed
      .split(/\s+/)
      .map((word: string) => word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim())
      .filter((word: string) => word.length > 2);

    for (let i = 0; i < words.length - 1; i++) {
      addCandidate(`${ words[i] } ${ words[i + 1] }`);
    }

    for (const word of words) {
      addCandidate(word);
    }

    return candidates.slice(0, 8);
  }

  private async searchTemplatesWithFallback(service: any, input: any): Promise<{
    templates:          any[];
    totalCount:         number;
    fallbackUsed:       boolean;
    matchedSearchTerm?: string;
  }> {
    const baseParams = {
      category: input.category,
      nodes:    input.nodes,
      page:     input.page,
      limit:    input.limit,
    };

    const originalSearch = typeof input.search === 'string' ? input.search.trim() : '';
    const initialResult = await service.searchTemplates({
      ...baseParams,
      search: originalSearch || undefined,
    });

    let templates = this.getTemplatesFromResult(initialResult);
    let totalCount = this.getTotalCountFromResult(initialResult, templates);

    if (templates.length > 0 || !originalSearch) {
      return { templates, totalCount, fallbackUsed: false };
    }

    const fallbackTerms = this.buildFallbackSearchTerms(originalSearch).filter(
      (term: string) => term.toLowerCase() !== originalSearch.toLowerCase(),
    );

    for (const term of fallbackTerms) {
      const fallbackResult = await service.searchTemplates({
        ...baseParams,
        search: term,
      });

      templates = this.getTemplatesFromResult(fallbackResult);
      totalCount = this.getTotalCountFromResult(fallbackResult, templates);

      if (templates.length > 0) {
        return {
          templates,
          totalCount,
          fallbackUsed:      true,
          matchedSearchTerm: term,
        };
      }
    }

    const generalFallbackResult = await service.searchTemplates(baseParams);
    templates = this.getTemplatesFromResult(generalFallbackResult);
    totalCount = this.getTotalCountFromResult(generalFallbackResult, templates);

    return {
      templates,
      totalCount,
      fallbackUsed: true,
    };
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const {
        templates,
        totalCount,
        fallbackUsed,
        matchedSearchTerm,
      } = await this.searchTemplatesWithFallback(service, input);

      const requestedLimit = Number(input?.limit);
      const displayLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.floor(requestedLimit)
        : 10;

      let message = `Found ${ totalCount } n8n workflow templates`;
      if (input.search) message += ` matching "${ input.search }"`;
      if (input.category) message += ` in category "${ input.category }"`;

      if (fallbackUsed && matchedSearchTerm) {
        message += ` (fallback match via "${ matchedSearchTerm }")`;
      } else if (fallbackUsed) {
        message += ` (fallback match via broad template search)`;
      }

      message += `:\n\n`;

      if (templates.length === 0) {
        message += 'No templates found matching your criteria.';
      } else {
        message += templates.slice(0, displayLimit).map((template: any, index: number) =>
          `${ index + 1 }. **${ template.name }**\n   ${ template.description || 'No description available' }\n   Category: ${ template.categories?.[0]?.name || template.category || 'Uncategorized' }\n   ID: ${ template.id }`,
        ).join('\n\n');

        if (templates.length > displayLimit) {
          message += `\n\n... and ${ templates.length - displayLimit } more templates`;
        }
      }

      return {
        successBoolean: true,
        responseString: message,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error searching n8n templates: ${ (error as Error).message }`,
      };
    }
  }
}
