import { BaseTool, ToolResponse } from '../base';
import { getChromeApi } from '@pkg/main/chromeApi';

/**
 * Search History Tool — search browsing history by text, time range, or both.
 */
export class SearchHistoryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const chrome = getChromeApi();

    try {
      const query: any = {
        text:       input.query || '',
        maxResults: input.maxResults || 20,
      };

      if (input.startTime) query.startTime = input.startTime;
      if (input.endTime) query.endTime = input.endTime;

      const items = await chrome.history.search(query);

      if (items.length === 0) {
        return {
          successBoolean: true,
          responseString: `No history entries found${ input.query ? ` matching "${ input.query }"` : '' }.`,
        };
      }

      const lines = items.map((h: any) => {
        const date = new Date(h.lastVisitTime).toLocaleString();

        return `  ${ date } — ${ h.title } (${ h.url }) [${ h.visitCount } visit(s)]`;
      });

      return {
        successBoolean: true,
        responseString: `Found ${ items.length } history entry(ies):\n${ lines.join('\n') }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `History search failed: ${ (error as Error).message }`,
      };
    }
  }
}
