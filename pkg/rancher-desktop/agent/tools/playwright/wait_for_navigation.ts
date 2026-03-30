/**
 * wait_for_navigation.ts
 *
 * Shared helper for interaction tools (click_element, set_field, etc.)
 * that may trigger page navigation. Listens for navigation/content events
 * and returns the new page state when it settles.
 */

import { hostBridgeProxy, ProxyBridge } from '../../scripts/injected/HostBridgeProxy';
import { wrapWithBlockingWarning } from './detect_blocking';

const NAV_LISTEN_WINDOW = 3000; // How long to wait for a nav event after interaction

interface PageState {
  navigated:  boolean;
  pageTitle:  string;
  pageUrl:    string;
  snapshot:   string;
  content:    string;
  scrollInfo: Record<string, unknown>;
  truncated:  boolean;
}

/**
 * Listen for navigation events on a specific assetId for a short window.
 * If navigation happens, wait for content to settle and return the new state.
 * If no navigation, return null (the page didn't change).
 */
export async function waitForNavigation(assetId: string): Promise<PageState | null> {
  return new Promise((resolve) => {
    let navDetected = false;

    const timeout = setTimeout(() => {
      unsub();
      if (!navDetected) {
        resolve(null); // No navigation happened
      }
    }, NAV_LISTEN_WINDOW);

    const unsub = hostBridgeProxy.onDomEvent((event) => {
      if (event.assetId !== assetId) return;

      if (event.type === 'routeChanged' || event.type === 'pageContent') {
        if (navDetected) return; // Already handling
        navDetected = true;
        clearTimeout(timeout);
        unsub();

        // Give the page a moment to finish rendering
        setTimeout(async() => {
          try {
            const state = await readPageState(assetId);
            resolve(state);
          } catch {
            resolve({ navigated: true, pageTitle: '', pageUrl: '', snapshot: '', content: '', scrollInfo: {}, truncated: false });
          }
        }, 1000);
      }
    });
  });
}

/**
 * Read full page state from a bridge.
 */
async function readPageState(assetId: string): Promise<PageState> {
  const bridge = hostBridgeProxy.resolve(assetId);
  const pageTitle = await bridge.getPageTitle();
  const pageUrl = await bridge.getPageUrl();
  const snapshot = await bridge.getActionableMarkdown();
  const readerContent = await bridge.getReaderContent();
  const scrollInfo = await bridge.getScrollInfo();

  return {
    navigated:  true,
    pageTitle,
    pageUrl,
    snapshot:   snapshot || '',
    content:    readerContent?.content || '',
    scrollInfo: scrollInfo as Record<string, unknown>,
    truncated:  readerContent?.truncated || false,
  };
}

/**
 * Format a PageState into a tool response string.
 */
export function formatPageState(assetId: string, state: PageState): string {
  const parts: string[] = [];
  parts.push(`[asset: ${ assetId }]`);
  parts.push(`**Navigated to**: ${ state.pageTitle }`);
  parts.push(`**URL**: ${ state.pageUrl }`);

  const scroll = state.scrollInfo as any;
  if (scroll?.moreBelow) {
    parts.push(`**Scroll**: ${ scroll.percent }% — more content below`);
  }

  if (state.snapshot.trim()) {
    parts.push('');
    parts.push(state.snapshot);
  }

  if (state.content.trim()) {
    parts.push('');
    parts.push('---');
    parts.push('## Page Content');
    parts.push(state.content);
    if (state.truncated) {
      parts.push('\n[Content truncated — use browse_page to read more]');
    }
  }

  const raw = parts.join('\n');
  const { responseString } = wrapWithBlockingWarning(raw, state.content || state.snapshot, state.pageUrl);
  return responseString;
}
