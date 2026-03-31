import { BaseTool, ToolResponse } from '../base';
import { getWebSocketClientService } from '../../services/WebSocketClientService';
import { hostBridgeProxy } from '../../scripts/injected/HostBridgeProxy';



/**
 * Browser Tab Tool — open, navigate, or close browser tabs.
 *
 * When opening/navigating an iframe tab, this tool:
 *   1. Sends the upsert command to the frontend
 *   2. Listens for the pageContent event from that assetId (page loaded)
 *   3. Returns the full page state: title, URL, interactive elements, and
 *      reader-mode content — so the agent doesn't need a second call
 */

const PAGE_LOAD_TIMEOUT = 60000; // dead-letter safety net — events should fire well before this

export class BrowserTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const action = String(input.action || 'upsert').trim().toLowerCase();
    // Default to 'iframe' — most common case and avoids the model forgetting assetType when navigating
    const assetType = String(input.assetType || 'iframe').trim().toLowerCase();
    const skillSlug = typeof input.skillSlug === 'string' ? input.skillSlug.trim() : '';
    const wsChannel = 'sulla-desktop';

    const wsService = getWebSocketClientService();

    /* ── Remove ── */
    if (action === 'remove') {
      const removeId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
      if (!removeId) {
        return { successBoolean: false, responseString: 'assetId is required when action is remove.' };
      }
      // Close the tab directly via bridge → renderer tab system
      const closed = await hostBridgeProxy.closeTabByAssetId(removeId);
      // Also notify the persona asset system for cleanup
      await wsService.send(wsChannel, {
        type: 'deactivate_asset', data: { assetId: removeId }, timestamp: Date.now(),
      });
      return {
        successBoolean: true,
        responseString: closed
          ? `Closed tab "${ removeId }"`
          : `Tab "${ removeId }" not found in tab system (asset deactivated)`,
      };
    }

    /* ── Validate ── */
    if (assetType !== 'iframe' && assetType !== 'document') {
      return { successBoolean: false, responseString: 'assetType must be either iframe or document.' };
    }

    const assetId = typeof input.assetId === 'string' && input.assetId.trim().length > 0
      ? input.assetId.trim()
      : `${ assetType }_${ Date.now() }`;

    const active = input.active !== false;
    const collapsed = input.collapsed !== false;
    const refKey = typeof input.refKey === 'string' ? input.refKey : undefined;
    const title = typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : (assetType === 'iframe' ? 'Website' : 'Document');

    /* ── Document upsert (no bridge needed) ── */
    if (assetType === 'document') {
      const content = typeof input.content === 'string' ? input.content : '';
      await wsService.send(wsChannel, {
        type: 'register_or_activate_asset',
        data: {
          asset: { type: 'document', id: assetId, title, content, active, collapsed, skillSlug: skillSlug || undefined, refKey },
        },
        timestamp: Date.now(),
      });
      return { successBoolean: true, responseString: `Upserted document asset id=${ assetId } contentLength=${ content.length }` };
    }

    /* ── Iframe upsert — open URL and wait for page load ── */
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!url) {
      return { successBoolean: false, responseString: 'url is required for iframe assets.' };
    }

    // Listen for bridge injection event BEFORE sending upsert
    const pageLoaded = this.waitForPageLoad(assetId);

    // Send the upsert command to the frontend
    await wsService.send(wsChannel, {
      type: 'register_or_activate_asset',
      data: {
        asset: { type: 'iframe', id: assetId, title, url, active, collapsed, skillSlug: skillSlug || undefined, refKey },
      },
      timestamp: Date.now(),
    });

    // Wait for the bridge to inject (event-driven, not polling)
    await pageLoaded;

    // Always read and return the page state
    return await this.readPageState(assetId, title, url);
  }

  /**
   * Wait for a pageContent or routeChanged dom event from the target assetId.
   * This fires when the GuestBridgePreload injects and emits sulla:pageContent.
   */
  private async waitForPageLoad(assetId: string): Promise<void> {
    // Check if already loaded (bridge already injected from a previous load)
    try {
      const bridge = hostBridgeProxy.resolve(assetId);
      if (await bridge.isInjected()) return; // already ready — no need to wait
    } catch { /* not registered yet — wait for event */ }

    // Not ready yet — wait for the injection event
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        unsub();
        resolve(); // safety net — still try to read whatever is available
      }, PAGE_LOAD_TIMEOUT);

      const unsub = hostBridgeProxy.onDomEvent((event) => {
        if (event.assetId !== assetId) return;
        if (event.type === 'pageContent' || event.type === 'injected' || event.type === 'routeChanged') {
          clearTimeout(timeout);
          unsub();
          resolve();
        }
      });
    });
  }

  /**
   * Read the full page state from an asset's bridge.
   * Waits for the bridge to be registered and injected for this exact assetId
   * before reading content.
   */
  private async readPageState(assetId: string, fallbackTitle: string, fallbackUrl: string): Promise<ToolResponse> {
    try {
      const bridge = hostBridgeProxy.resolve(assetId);

      // Wait for bridge injection
      for (let attempt = 0; attempt < 6; attempt++) {
        const injected = await bridge.isInjected();
        if (injected) break;
        if (attempt < 5) await new Promise(r => setTimeout(r, 500));
      }

      const pageTitle = await bridge.getPageTitle();
      const pageUrl = await bridge.getPageUrl();

      // Return dehydrated DOM — compact, actionable, token-efficient
      let tree = '';
      let stats: any = {};
      try {
        const raw = await bridge.execInPage(
          'window.__sulla ? window.__sulla.dehydrate({ maxTokens: 4000 }) : null',
        );
        if (raw && typeof raw === 'object') {
          const d = raw as any;
          tree = d.tree || '';
          stats = d.stats || {};
        }
      } catch { /* runtime not available — fall back to basic info */ }

      const parts: string[] = [];
      parts.push(`[asset: ${ assetId }]`);
      parts.push(`# ${ pageTitle || fallbackTitle }`);
      parts.push(`**URL**: ${ pageUrl || fallbackUrl }`);

      if (tree) {
        parts.push(`**Stats**: ${ stats.tokens ?? '?' } tokens | ${ stats.interactiveCount ?? '?' } interactive | depth ${ stats.depth ?? '?' }`);
        parts.push('');
        parts.push(tree);
      } else {
        // Fallback: just return title + URL if dehydrate isn't available
        const text = await bridge.getPageText();
        if (text) {
          parts.push('');
          parts.push(text.substring(0, 2000));
        }
      }

      return { successBoolean: true, responseString: parts.join('\n') };
    } catch (err) {
      return {
        successBoolean: true,
        responseString: `Opened tab id=${ assetId } url=${ fallbackUrl } — bridge connected but content read failed: ${ (err as Error).message }`,
      };
    }
  }
}
