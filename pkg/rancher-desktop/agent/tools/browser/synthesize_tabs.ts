import { tabRegistry } from '@pkg/main/browserTabs/TabRegistry';

import { BaseTool, ToolResponse } from '../base';
import { extractReadableContent } from './readability-extract';

/**
 * Synthesize Tabs Tool — extracts reader-mode content from multiple open
 * browser tabs and returns them in a single response with source attribution.
 *
 * Useful for cross-page research: comparing information across sites,
 * aggregating data from multiple sources, or building a summary from
 * several references.
 */
export class SynthesizeTabsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const requestedIds: string[] = Array.isArray(input.assetIds)
      ? input.assetIds
      : typeof input.assetIds === 'string'
        ? input.assetIds.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];

    const maxCharsPerTab = typeof input.max_chars === 'number' ? input.max_chars : 4000;

    try {
      const allTabs = tabRegistry.list();
      if (allTabs.length === 0) {
        return { successBoolean: false, responseString: 'No browser tabs open.' };
      }

      const targetTabs = requestedIds.length > 0
        ? allTabs.filter(t => requestedIds.includes(t.assetId))
        : allTabs.filter(t => !t.isLoading);

      if (targetTabs.length === 0) {
        const available = allTabs.map(t => `  - ${ t.assetId } "${ t.title }" (${ t.url })`).join('\n');
        return { successBoolean: false, responseString: `No matching tabs found. Available:\n${ available }` };
      }

      const results = await Promise.all(targetTabs.map(async(asset) => {
        const bridge = tabRegistry.bridge(asset.assetId);
        if (!bridge) return { assetId: asset.assetId, title: asset.title, url: asset.url, content: '' };
        let content = '';
        let title = asset.title;

        try {
          // Try Readability first
          const html = await bridge.getPageHtml();
          if (html && html.length > 200) {
            const extracted = await extractReadableContent({
              html,
              url:         asset.url,
              extractMode: 'markdown',
            });
            if (extracted?.text && extracted.text.trim().length > 100) {
              content = extracted.text;
              if (extracted.title) title = extracted.title;
            }
          }
        } catch { /* ignore */ }

        // Fallback to guest-side extraction
        if (!content) {
          try {
            const reader = await bridge.getReaderContent(maxCharsPerTab);
            if (reader?.content) content = reader.content;
          } catch { /* ignore */ }
        }

        // Final fallback: raw text
        if (!content) {
          try {
            content = await bridge.getPageText();
          } catch { /* ignore */ }
        }

        // Truncate per tab
        if (content.length > maxCharsPerTab) {
          content = content.slice(0, maxCharsPerTab) + '\n\n[...truncated]';
        }

        return { assetId: asset.assetId, title, url: asset.url, content };
      }));

      // Build combined response
      const sections = results.map((r, i) => {
        const header = `## Source ${ i + 1 }: ${ r.title }\n**Asset**: \`${ r.assetId }\`\n**URL**: ${ r.url }`;
        if (!r.content.trim()) {
          return `${ header }\n\n*No readable content extracted.*`;
        }
        return `${ header }\n\n${ r.content }`;
      });

      const tabCount = results.length;
      const withContent = results.filter(r => r.content.trim()).length;

      return {
        successBoolean: true,
        responseString: `# Cross-Tab Synthesis (${ tabCount } tabs, ${ withContent } with content)\n\n${ sections.join('\n\n---\n\n') }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error synthesizing tabs: ${ (error as Error).message }`,
      };
    }
  }
}
