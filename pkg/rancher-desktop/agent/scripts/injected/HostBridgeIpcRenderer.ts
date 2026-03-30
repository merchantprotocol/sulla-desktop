/**
 * HostBridgeIpcRenderer.ts
 *
 * Renderer-side IPC handler for the host bridge proxy.
 * Listens for bridge method requests from the main process via WebSocket
 * and delegates to the real hostBridgeRegistry that lives in this process.
 *
 * Also pushes DOM events from registered bridges to main so the agent
 * can receive live page updates during execution.
 */

import { hostBridgeRegistry } from './HostBridgeRegistry';
import { getWebSocketClientService } from '../../services/WebSocketClientService';

const WS_CHANNEL = 'bridge-ipc';

let initialized = false;

export function initHostBridgeIpc(): void {
  if (initialized) return;
  initialized = true;

  const wsService = getWebSocketClientService();
  wsService.connect(WS_CHANNEL);

  // ── Handle method-call requests from main ──
  wsService.onMessage(WS_CHANNEL, async(msg) => {
    if (msg.type !== 'bridge:request') return;

    const { requestId, method, args } = msg.data as {
      requestId: string;
      method:    string;
      args:      unknown[];
    };

    let result: unknown;
    let error: string | null = null;

    try {
      result = await handleMethod(method, args);
    } catch (err) {
      error = String(err);
    }

    await wsService.send(WS_CHANNEL, {
      type:      'bridge:response',
      data:      { requestId, result, error },
      timestamp: Date.now(),
    });
  });

  // ── Push DOM events to main ──
  hostBridgeRegistry.onDomEvent((event) => {
    wsService.send(WS_CHANNEL, {
      type:      'bridge:dom-event',
      data:      event,
      timestamp: Date.now(),
    });
  });

  console.log('[HostBridgeIpcRenderer] initialized on channel', WS_CHANNEL);
}

/* ------------------------------------------------------------------ */
/*  Method dispatcher                                                  */
/* ------------------------------------------------------------------ */

async function handleMethod(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    // ── Registry-level queries ──

    case 'getSystemPromptContext':
      return await hostBridgeRegistry.getSystemPromptContext(
        typeof args[0] === 'number' ? args[0] : undefined,
      );

    case 'size':
      return hostBridgeRegistry.size();

    case 'getActiveAssetId':
      return hostBridgeRegistry.getActiveAssetId();

    case 'getAllAssetInfo':
      return hostBridgeRegistry.getAllEntries().map(e => ({
        assetId:    e.assetId,
        title:      e.title,
        url:        e.url,
        isInjected: e.bridge.isInjected(),
      }));

    // ── Per-bridge methods (first arg is always assetId) ──

    case 'resolve:isInjected': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge?.isInjected() ?? false;
    }

    case 'resolve:getActionableMarkdown': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.getActionableMarkdown() : null;
    }

    case 'resolve:click': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.click(args[1] as string) : false;
    }

    case 'resolve:setValue': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.setValue(args[1] as string, args[2] as string) : false;
    }

    case 'resolve:pressKey': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));
      return bridge ? await bridge.pressKey(args[1] as string, args[2] as string | undefined) : false;
    }

    case 'resolve:getFormValues': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.getFormValues() : {};
    }

    case 'resolve:scrollTo': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.scrollTo(args[1] as string) : false;
    }

    case 'resolve:waitForSelector': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge
        ? await bridge.waitForSelector(args[1] as string, typeof args[2] === 'number' ? args[2] : undefined)
        : false;
    }

    case 'resolve:getPageText': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.getPageText() : '';
    }

    case 'resolve:getReaderContent': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));
      const maxChars = typeof args[1] === 'number' ? args[1] : undefined;

      return bridge ? await bridge.getReaderContent(maxChars) : null;
    }

    case 'resolve:getScrollInfo': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.getScrollInfo() : null;
    }

    case 'resolve:scrollAndCapture': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));
      const direction = typeof args[1] === 'string' ? args[1] : undefined;

      return bridge ? await bridge.scrollAndCapture(direction) : null;
    }

    case 'resolve:scrollToTop': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.scrollToTop() : null;
    }

    case 'resolve:searchInPage': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.searchInPage(args[1] as string) : null;
    }

    case 'resolve:getPageHtml': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.getPageHtml() : '';
    }

    case 'resolve:execInPage': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));
      if (!bridge) return null;
      return await bridge.execInPage(args[1] as string);
    }

    case 'resolve:getPageTitle': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.getPageTitle() : '';
    }

    case 'resolve:getPageUrl': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));

      return bridge ? await bridge.getPageUrl() : '';
    }

    default:
      throw new Error(`Unknown bridge method: ${ method }`);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
