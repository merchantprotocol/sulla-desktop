/**
 * HostBridgeProxy.ts
 *
 * Main-process proxy for the host bridge registry.
 * All calls are forwarded to the renderer via WebSocket on channel `bridge-ipc`.
 *
 * The renderer side (HostBridgeIpcRenderer) handles the requests and sends
 * responses back.  DOM events are also pushed from renderer → main so the
 * agent can receive live page updates.
 *
 * Usage from main-process code:
 *
 *   import { hostBridgeProxy } from './HostBridgeProxy';
 *
 *   const ctx = await hostBridgeProxy.getSystemPromptContext();
 *   const bridge = hostBridgeProxy.resolve('my-asset');
 *   const md = await bridge.getActionableMarkdown();
 */

import { getWebSocketClientService } from '../../services/WebSocketClientService';

const WS_CHANNEL = 'bridge-ipc';

/* ------------------------------------------------------------------ */
/*  Initialization & WS wiring                                         */
/* ------------------------------------------------------------------ */

let initialized = false;

const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject:  (error: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}>();

type DomEventHandler = (event: {
  assetId:   string;
  type:      string;
  message:   string;
  timestamp: number;
}) => void;

const domEventHandlers = new Set<DomEventHandler>();

let requestCounter = 0;

function ensureInit(): void {
  if (initialized) return;
  initialized = true;

  const wsService = getWebSocketClientService();
  wsService.connect(WS_CHANNEL);

  wsService.onMessage(WS_CHANNEL, (msg) => {
    if (msg.type === 'bridge:response') {
      const { requestId, result, error } = msg.data as {
        requestId: string;
        result:    unknown;
        error:     string | null;
      };
      const pending = pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(requestId);
        if (error) {
          pending.reject(new Error(error));
        } else {
          pending.resolve(result);
        }
      }
    } else if (msg.type === 'bridge:dom-event') {
      for (const handler of domEventHandlers) {
        try { handler(msg.data as any) } catch { /* no-op */ }
      }
    }
  });

  console.log('[HostBridgeProxy] initialized on channel', WS_CHANNEL);
}

/* ------------------------------------------------------------------ */
/*  RPC helper                                                         */
/* ------------------------------------------------------------------ */

async function callRenderer(method: string, args: unknown[] = [], timeoutMs = 30000): Promise<unknown> {
  ensureInit();

  const requestId = `br-${ Date.now() }-${ ++requestCounter }`;
  const wsService = getWebSocketClientService();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`[HostBridgeProxy] timeout calling ${ method } (requestId=${ requestId })`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });

    wsService.send(WS_CHANNEL, {
      type:      'bridge:request',
      data:      { requestId, method, args },
      timestamp: Date.now(),
    });
  });
}

/* ------------------------------------------------------------------ */
/*  ProxyBridge — per-asset bridge that forwards method calls          */
/* ------------------------------------------------------------------ */

export class ProxyBridge {
  private assetId: string | undefined;

  constructor(assetId?: string) {
    this.assetId = assetId;
  }

  async isInjected(): Promise<boolean> {
    return (await callRenderer('resolve:isInjected', [this.assetId])) as boolean;
  }

  async getActionableMarkdown(): Promise<string> {
    return ((await callRenderer('resolve:getActionableMarkdown', [this.assetId])) as string) || '';
  }

  async click(handle: string): Promise<boolean> {
    return (await callRenderer('resolve:click', [this.assetId, handle])) as boolean;
  }

  async setValue(handle: string, value: string): Promise<boolean> {
    return (await callRenderer('resolve:setValue', [this.assetId, handle, value])) as boolean;
  }

  async pressKey(key: string, handle?: string): Promise<boolean> {
    return (await callRenderer('resolve:pressKey', [this.assetId, key, handle])) as boolean;
  }

  async getFormValues(): Promise<Record<string, string>> {
    return ((await callRenderer('resolve:getFormValues', [this.assetId])) as Record<string, string>) || {};
  }

  async scrollTo(selector: string): Promise<boolean> {
    return (await callRenderer('resolve:scrollTo', [this.assetId, selector])) as boolean;
  }

  async waitForSelector(selector: string, timeoutMs?: number): Promise<boolean> {
    return (await callRenderer('resolve:waitForSelector', [this.assetId, selector, timeoutMs])) as boolean;
  }

  async getPageText(): Promise<string> {
    return ((await callRenderer('resolve:getPageText', [this.assetId])) as string) || '';
  }

  async getReaderContent(maxChars?: number): Promise<{
    title: string; url: string; content: string;
    contentLength: number; truncated: boolean;
  } | null> {
    return (await callRenderer('resolve:getReaderContent', [this.assetId, maxChars])) as {
      title: string; url: string; content: string;
      contentLength: number; truncated: boolean;
    } | null;
  }

  async getScrollInfo(): Promise<{
    scrollY: number; scrollHeight: number; viewportHeight: number;
    percent: number; atTop: boolean; atBottom: boolean;
    moreBelow: boolean; moreAbove: boolean;
  }> {
    const result = await callRenderer('resolve:getScrollInfo', [this.assetId]);
    return (result as any) || {
      scrollY: 0, scrollHeight: 0, viewportHeight: 0, percent: 0,
      atTop: true, atBottom: true, moreBelow: false, moreAbove: false,
    };
  }

  async scrollAndCapture(direction?: string): Promise<{
    newContent: string; scrollInfo: Record<string, unknown>; noNewContent: boolean;
  }> {
    const result = await callRenderer('resolve:scrollAndCapture', [this.assetId, direction]);
    return (result as any) || { newContent: '', scrollInfo: {}, noNewContent: true };
  }

  async scrollToTop(): Promise<Record<string, unknown>> {
    const result = await callRenderer('resolve:scrollToTop', [this.assetId]);
    return (result as any) || {};
  }

  async searchInPage(query: string): Promise<{
    matches: Array<{ index: number; context: string }>; total: number; query: string;
  }> {
    const result = await callRenderer('resolve:searchInPage', [this.assetId, query]);
    return (result as any) || { matches: [], total: 0, query };
  }

  async getPageHtml(): Promise<string> {
    return ((await callRenderer('resolve:getPageHtml', [this.assetId])) as string) || '';
  }

  async execInPage(code: string): Promise<unknown> {
    return await callRenderer('resolve:execInPage', [this.assetId, code]);
  }

  async getPageTitle(): Promise<string> {
    return ((await callRenderer('resolve:getPageTitle', [this.assetId])) as string) || '';
  }

  async getPageUrl(): Promise<string> {
    return ((await callRenderer('resolve:getPageUrl', [this.assetId])) as string) || '';
  }

  // ── Visual / Computer Use methods ─────────────────────────────────

  /** Capture a screenshot of the page via CDP. Returns base64 + mediaType. */
  async captureScreenshot(options?: {
    format?: 'jpeg' | 'png';
    quality?: number;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<{ base64: string; mediaType: string } | null> {
    return (await callRenderer('resolve:captureScreenshot', [this.assetId, options])) as {
      base64: string; mediaType: string;
    } | null;
  }

  /** Move mouse to coordinates via CDP (triggers hover effects). */
  async moveMouse(x: number, y: number): Promise<boolean> {
    return (await callRenderer('resolve:moveMouse', [this.assetId, x, y])) as boolean;
  }

  /** Click at pixel coordinates via CDP (trusted mouse events). */
  async clickAtCoordinate(x: number, y: number, options?: {
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
  }): Promise<boolean> {
    return (await callRenderer('resolve:clickAtCoordinate', [this.assetId, x, y, options])) as boolean;
  }

  /** Dispatch a mouse move + press + release (drag) via CDP. */
  async dragFromTo(
    fromX: number, fromY: number, toX: number, toY: number,
  ): Promise<boolean> {
    return (await callRenderer('resolve:dragFromTo', [this.assetId, fromX, fromY, toX, toY])) as boolean;
  }

  /** Scroll at pixel coordinates via CDP wheel event. */
  async scrollAtCoordinate(x: number, y: number, deltaX: number, deltaY: number): Promise<boolean> {
    return (await callRenderer('resolve:scrollAtCoordinate', [this.assetId, x, y, deltaX, deltaY])) as boolean;
  }

  /** Type text character-by-character via CDP keyboard events. */
  async typeText(text: string): Promise<boolean> {
    return (await callRenderer('resolve:typeText', [this.assetId, text])) as boolean;
  }

  /** Add/remove element annotation overlays for numbered bounding boxes. */
  async annotateElements(): Promise<Array<{ index: number; label: string; x: number; y: number; width: number; height: number }>> {
    return (await callRenderer('resolve:annotateElements', [this.assetId])) as any[] || [];
  }

  async removeAnnotations(): Promise<void> {
    await callRenderer('resolve:removeAnnotations', [this.assetId]);
  }
}

/* ------------------------------------------------------------------ */
/*  Public API — mirrors HostBridgeRegistryImpl interface               */
/* ------------------------------------------------------------------ */

export interface AssetInfo {
  assetId:    string;
  title:      string;
  url:        string;
  isInjected: boolean;
}

export const hostBridgeProxy = {
  async getSystemPromptContext(maxAgeMs?: number): Promise<string> {
    return ((await callRenderer('getSystemPromptContext', [maxAgeMs])) as string) || '';
  },

  async size(): Promise<number> {
    return ((await callRenderer('size')) as number) || 0;
  },

  async getActiveAssetId(): Promise<string | null> {
    return ((await callRenderer('getActiveAssetId')) as string) || null;
  },

  resolve(assetId?: string): ProxyBridge {
    return new ProxyBridge(assetId);
  },

  async getAllAssetInfo(): Promise<AssetInfo[]> {
    return ((await callRenderer('getAllAssetInfo')) as AssetInfo[]) || [];
  },

  /** Close a browser tab by its assetId. Removes from both bridge registry and tab system. */
  async closeTabByAssetId(assetId: string): Promise<boolean> {
    return ((await callRenderer('closeTabByAssetId', [assetId])) as boolean) || false;
  },

  onDomEvent(handler: DomEventHandler): () => void {
    ensureInit();
    domEventHandlers.add(handler);

    return () => { domEventHandlers.delete(handler) };
  },
};
