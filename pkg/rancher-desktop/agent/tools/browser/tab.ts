import { hostBridgeProxy } from '../../scripts/injected/HostBridgeProxy';
import { getWebSocketClientService } from '../../services/WebSocketClientService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Browser Tab Tool — open, navigate, or close browser tabs.
 *
 * When opening/navigating a browser tab, this tool:
 *   1. Sends the upsert command to the frontend
 *   2. Listens for the pageContent event from that assetId (page loaded)
 *   3. Returns the full page state: title, URL, interactive elements, and
 *      reader-mode content — so the agent doesn't need a second call
 */

export class BrowserTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const action = String(input.action || 'upsert').trim().toLowerCase();
    // Default to 'browser'. Accept 'iframe' as a legacy alias.
    let assetType = String(input.assetType || 'browser').trim().toLowerCase();
    if (assetType === 'iframe') assetType = 'browser';
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
    if (assetType !== 'browser' && assetType !== 'document') {
      return { successBoolean: false, responseString: 'assetType must be browser or document.' };
    }

    // When the caller doesn't supply an assetId, derive one from URL + the
    // current thread so:
    //   • repeated upsert calls in the SAME thread for the SAME URL reuse
    //     the same tab (no spawn-loop),
    //   • parallel threads that happen to hit the same URL each get their
    //     own tab (no cross-thread collision),
    //   • once the tab has been created its id is stable, so later
    //     navigation inside the tab doesn't make the next upsert think
    //     it's a different tab — same thread + same URL always resolves
    //     to the same id.
    //
    // Callers that want an explicit, stable id across threads should pass
    // assetId directly.
    const urlForId = typeof input.url === 'string' ? input.url.trim() : '';
    const threadScope = (this.state?.metadata?.threadId || 'default').toString().slice(-8);
    const deriveIdFromUrl = (u: string) => {
      try {
        const parsed = new URL(u);
        const host = parsed.hostname.replace(/^www\./, '').replace(/\./g, '-');
        const path = parsed.pathname.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
        return `${ assetType }_${ threadScope }_${ host }${ path ? `_${ path }` : '' }`;
      } catch {
        return `${ assetType }_${ threadScope }_${ Date.now() }`;
      }
    };
    const assetId = typeof input.assetId === 'string' && input.assetId.trim().length > 0
      ? input.assetId.trim()
      : urlForId
        ? deriveIdFromUrl(urlForId)
        : `${ assetType }_${ threadScope }_${ Date.now() }`;

    const active = input.active !== false;
    const collapsed = input.collapsed !== false;
    const refKey = typeof input.refKey === 'string' ? input.refKey : undefined;
    const title = typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : (assetType === 'browser' ? 'Website' : 'Document');

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
      return { successBoolean: false, responseString: 'url is required for browser assets.' };
    }

    // Send the upsert command to the frontend
    await wsService.send(wsChannel, {
      type: 'register_or_activate_asset',
      data: {
        asset: { type: 'browser', id: assetId, title, url, active, collapsed, skillSlug: skillSlug || undefined, refKey },
      },
      timestamp: Date.now(),
    });

    // readPageState calls bridge methods which auto-wait for READY state
    // via the WebviewHostBridge state machine. No manual waiting needed.
    return await this.readPageState(assetId, title, url);
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
        const text = await bridge.getPageText();
        if (text) {
          parts.push('');
          parts.push(text.substring(0, 2000));
        }
      }

      parts.push('');
      parts.push('---');
      parts.push('**How to interact with this page:**');
      parts.push('Handle-based (preferred): `browser/click` with @btn-/@link- handles, `browser/fill` with @field- handles.');
      parts.push('Pixel-based: `browser/screenshot` to identify coords, then `browser/click_at` / `browser/type_at`.');
      parts.push('Escape hatch: `browser/exec` runs arbitrary JS with `window.__sulla` helpers (`__sulla.steps`, `__sulla.waitFor`, `__sulla.text`).');
      parts.push('Load the `web-research-playwright` skill for the full helper reference.');

      return { successBoolean: true, responseString: parts.join('\n') };
    } catch (err) {
      return {
        successBoolean: true,
        responseString: `Opened tab id=${ assetId } url=${ fallbackUrl } — bridge connected but content read failed: ${ (err as Error).message }`,
      };
    }
  }
}
