import { BaseTool, ToolResponse } from '../base';

import { getChromeApi } from '@pkg/main/chromeApi';

/**
 * Background Browse Tool — open a hidden tab, navigate, read content, close.
 *
 * Lets the AI agent do research without stealing the user's visible tab.
 * The hidden WebContentsView is fully functional (cookies, JS, network)
 * but not attached to any window.
 */
export class BackgroundBrowseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const chrome = getChromeApi();
    const action = input.action as string;

    try {
      switch (action) {
      case 'open': {
        if (!input.url) {
          return { successBoolean: false, responseString: '"url" is required for open action.' };
        }

        const tab = await chrome.tabs.create({ url: input.url, hidden: true });

        // Wait for page to load
        const waitMs = input.waitMs || 3000;

        await new Promise(resolve => setTimeout(resolve, waitMs));

        // Read content
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          code:   'document.title + "\\n\\n" + document.body.innerText.substring(0, 8000)',
        });

        const content = results[0]?.result as string || '';

        return {
          successBoolean: true,
          responseString: `[Hidden tab ${ tab.id }] Loaded ${ input.url }\n\n${ content }`,
        };
      }

      case 'read': {
        if (!input.tabId) {
          return { successBoolean: false, responseString: '"tabId" is required for read action.' };
        }

        const tab = await chrome.tabs.get(input.tabId);

        if (!tab) {
          return { successBoolean: false, responseString: `Tab ${ input.tabId } not found.` };
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId: input.tabId },
          code:   input.code || 'document.title + "\\n\\n" + document.body.innerText.substring(0, 8000)',
        });

        const content = results[0]?.result as string || '';

        return {
          successBoolean: true,
          responseString: `[${ input.tabId }] ${ tab.url }\n\n${ content }`,
        };
      }

      case 'navigate': {
        if (!input.tabId || !input.url) {
          return { successBoolean: false, responseString: '"tabId" and "url" are required for navigate action.' };
        }

        await chrome.tabs.update(input.tabId, { url: input.url });

        const waitMs = input.waitMs || 3000;

        await new Promise(resolve => setTimeout(resolve, waitMs));

        const results = await chrome.scripting.executeScript({
          target: { tabId: input.tabId },
          code:   'document.title + "\\n\\n" + document.body.innerText.substring(0, 8000)',
        });

        const content = results[0]?.result as string || '';

        return {
          successBoolean: true,
          responseString: `[${ input.tabId }] Navigated to ${ input.url }\n\n${ content }`,
        };
      }

      case 'close': {
        if (!input.tabId) {
          return { successBoolean: false, responseString: '"tabId" is required for close action.' };
        }

        await chrome.tabs.remove(input.tabId);

        return { successBoolean: true, responseString: `Hidden tab ${ input.tabId } closed.` };
      }

      case 'list': {
        const tabs = await chrome.tabs.query({ hidden: true });

        if (tabs.length === 0) {
          return { successBoolean: true, responseString: 'No hidden tabs open.' };
        }

        const lines = tabs.map(t => `  ${ t.id } — ${ t.title } (${ t.url }) [${ t.status }]`);

        return {
          successBoolean: true,
          responseString: `${ tabs.length } hidden tab(s):\n${ lines.join('\n') }`,
        };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use open, read, navigate, close, or list.` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `Background browse failed: ${ (error as Error).message }` };
    }
  }
}
