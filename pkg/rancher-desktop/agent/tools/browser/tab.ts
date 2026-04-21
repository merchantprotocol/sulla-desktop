// tab.ts — Open, navigate, or close a browser tab.
//
// Main-process agent tool. Talks to TabRegistry directly; no IPC hop to
// the renderer, no register_or_activate_asset WebSocket dance, no bridge
// state machine. After opening, reads the page state off the same
// WebContents via GuestBridge.

import { tabRegistry } from '@pkg/main/browserTabs/TabRegistry';

import { BaseTool, ToolResponse } from '../base';

export class BrowserTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const action = String(input.action || 'upsert').trim().toLowerCase();

    // `document` assetType was a document-content rendering hack that lived
    // in the old asset system. Not supported in the simplified model.
    let assetType = String(input.assetType || 'browser').trim().toLowerCase();
    if (assetType === 'iframe') assetType = 'browser';

    // ── Remove ──
    if (action === 'remove') {
      const removeId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
      if (!removeId) {
        return { successBoolean: false, responseString: 'assetId is required when action is remove.' };
      }
      const closed = tabRegistry.close(removeId);
      return {
        successBoolean: true,
        responseString: closed ? `Closed tab "${ removeId }"` : `Tab "${ removeId }" not found.`,
      };
    }

    if (assetType !== 'browser') {
      return { successBoolean: false, responseString: 'assetType must be browser. Document rendering was removed in the tab system simplification.' };
    }

    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!url) {
      return { successBoolean: false, responseString: 'url is required for browser tabs.' };
    }

    // Derive a stable assetId when the caller doesn't supply one, scoped
    // by thread so parallel threads don't collide and repeated upserts in
    // the same thread reuse the tab.
    const threadScope = (this.state?.metadata?.threadId || 'default').toString().slice(-8);
    const deriveIdFromUrl = (u: string): string => {
      try {
        const parsed = new URL(u);
        const host = parsed.hostname.replace(/^www\./, '').replace(/\./g, '-');
        const path = parsed.pathname.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
        return `browser_${ threadScope }_${ host }${ path ? `_${ path }` : '' }`;
      } catch {
        return `browser_${ threadScope }_${ Date.now() }`;
      }
    };

    const assetId = typeof input.assetId === 'string' && input.assetId.trim().length > 0
      ? input.assetId.trim()
      : deriveIdFromUrl(url);

    const title = typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim() : 'Website';

    tabRegistry.open({ assetId, url, title, origin: 'agent' });

    return await this.readPageState(assetId, title, url);
  }

  /**
   * Read the page state immediately after open/navigate. The guest preload
   * runs at document-start, so window.sullaBridge is live as soon as the
   * first executeJavaScript round-trip succeeds.
   */
  private async readPageState(assetId: string, fallbackTitle: string, fallbackUrl: string): Promise<ToolResponse> {
    const bridge = tabRegistry.bridge(assetId);
    if (!bridge) {
      return { successBoolean: false, responseString: `Tab "${ assetId }" was not created.` };
    }

    try {
      const pageTitle = await bridge.getPageTitle();
      const pageUrl = await bridge.getPageUrl();

      // Try to get a dehydrated DOM tree (the agent's preferred format).
      let tree = '';
      let stats: any = {};
      const raw = await bridge.execInPage(
        'window.__sulla ? window.__sulla.dehydrate({ maxTokens: 4000 }) : null',
      );
      if (raw && typeof raw === 'object') {
        const d = raw as any;
        tree = d.tree || '';
        stats = d.stats || {};
      }

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
      parts.push('Escape hatch: `browser/exec` runs arbitrary JS with `window.__sulla` helpers.');

      return { successBoolean: true, responseString: parts.join('\n') };
    } catch (err) {
      return {
        successBoolean: true,
        responseString: `Opened tab id=${ assetId } url=${ fallbackUrl } — content read failed: ${ (err as Error).message }`,
      };
    }
  }
}
