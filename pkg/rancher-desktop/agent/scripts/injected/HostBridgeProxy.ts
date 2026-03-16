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

async function callRenderer(method: string, args: unknown[] = [], timeoutMs = 15000): Promise<unknown> {
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

  async getPageTitle(): Promise<string> {
    return ((await callRenderer('resolve:getPageTitle', [this.assetId])) as string) || '';
  }

  async getPageUrl(): Promise<string> {
    return ((await callRenderer('resolve:getPageUrl', [this.assetId])) as string) || '';
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

  onDomEvent(handler: DomEventHandler): () => void {
    ensureInit();
    domEventHandlers.add(handler);

    return () => { domEventHandlers.delete(handler) };
  },
};
