/**
 * wait_for_navigation.ts
 *
 * Shared helper for interaction tools (click_element, set_field) that may
 * trigger page navigation. Listens for navigation/content events and
 * returns the new page state when it settles.
 *
 * Bridge readiness is handled by the state machine in WebviewHostBridge —
 * commands auto-wait for READY state, so no manual waiting is needed here.
 */

import { hostBridgeProxy } from '../../scripts/injected/HostBridgeProxy';
import { wrapWithBlockingWarning } from './detect_blocking';

const NAV_LISTEN_WINDOW = 3000;

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
 * If navigation happens, waits for the bridge to reach READY (via its
 * state machine), then reads and returns the new page state.
 */
export async function waitForNavigation(assetId: string): Promise<PageState | null> {
  return new Promise((resolve) => {
    let navDetected = false;

    const timeout = setTimeout(() => {
      unsub();
      if (!navDetected) {
        resolve(null);
      }
    }, NAV_LISTEN_WINDOW);

    const unsub = hostBridgeProxy.onDomEvent((event) => {
      if (event.assetId !== assetId) return;

      if (event.type === 'routeChanged' || event.type === 'pageContent') {
        if (navDetected) return;
        navDetected = true;
        clearTimeout(timeout);
        unsub();

        // Read state — bridge commands auto-wait for READY via state machine
        (async() => {
          try {
            const state = await readPageState(assetId);
            resolve(state);
          } catch {
            resolve({ navigated: true, pageTitle: '', pageUrl: '', snapshot: '', content: '', scrollInfo: {}, truncated: false });
          }
        })();
      }
    });
  });
}

/**
 * Read full page state from a bridge.
 * Bridge methods auto-wait for READY — no manual waiting needed.
 */
async function readPageState(assetId: string): Promise<PageState> {
  const bridge = hostBridgeProxy.resolve(assetId);

  const pageTitle = await bridge.getPageTitle();
  const pageUrl = await bridge.getPageUrl();

  let snapshot = '';
  let readerContent: { content: string; truncated: boolean } | null = null;
  let scrollInfo: Record<string, unknown> = {};

  try { snapshot = await bridge.getActionableMarkdown() || ''; } catch { /* */ }
  try { readerContent = await bridge.getReaderContent(); } catch { /* */ }
  try { scrollInfo = await bridge.getScrollInfo() as Record<string, unknown>; } catch { /* */ }

  return {
    navigated:  true,
    pageTitle,
    pageUrl,
    snapshot,
    content:    readerContent?.content || '',
    scrollInfo,
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
