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
import { closeTabByAssetId } from '@pkg/composables/useBrowserTabs';
import { getWebSocketClientService } from '../../services/WebSocketClientService';

/**
 * Get the bounding rect offset of the iframe for a given assetId.
 * CDP mouse events target the full renderer window, but tool coordinates
 * are relative to the iframe content. This returns the offset to translate.
 */
function getIframeOffset(assetId?: string): { x: number; y: number } {
  // Find the iframe element in the renderer DOM
  const iframes = document.querySelectorAll('iframe.browser-frame, iframe[src]');
  for (const iframe of iframes) {
    const rect = iframe.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { x: Math.round(rect.left), y: Math.round(rect.top) };
    }
  }
  return { x: 0, y: 0 };
}

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

    // ── Visual / Computer Use methods (CDP-based) ──

    case 'resolve:captureScreenshot': {
      const options = (args[1] as any) || {};
      try {
        const { ipcRenderer } = require('electron');
        // Crop to iframe bounds so screenshot matches grid/annotation coordinates
        if (!options.clip) {
          const offset = getIframeOffset(asString(args[0]));
          const iframe = document.querySelector('iframe.browser-frame, iframe[src]') as HTMLIFrameElement | null;
          if (iframe) {
            const rect = iframe.getBoundingClientRect();
            options.clip = {
              x:      Math.round(rect.left),
              y:      Math.round(rect.top),
              width:  Math.round(rect.width),
              height: Math.round(rect.height),
              scale:  1,
            };
          }
        }
        return await ipcRenderer.invoke('browser-tab:capture-screenshot', options);
      } catch (err) {
        console.warn('[HostBridgeIpcRenderer] captureScreenshot error:', err);
        return null;
      }
    }

    case 'resolve:clickAtCoordinate': {
      const offset = getIframeOffset(asString(args[0]));
      const x = (args[1] as number) + offset.x;
      const y = (args[2] as number) + offset.y;
      const options = (args[3] as any) || {};
      try {
        const { ipcRenderer } = require('electron');
        await ipcRenderer.invoke('browser-tab:send-mouse-event', {
          type: 'mousePressed', x, y,
          button: options.button ?? 'left',
          clickCount: options.clickCount ?? 1,
        });
        await ipcRenderer.invoke('browser-tab:send-mouse-event', {
          type: 'mouseReleased', x, y,
          button: options.button ?? 'left',
          clickCount: options.clickCount ?? 1,
        });
        return true;
      } catch (err) {
        console.warn('[HostBridgeIpcRenderer] clickAtCoordinate error:', err);
        return false;
      }
    }

    case 'resolve:moveMouse': {
      const moveOffset = getIframeOffset(asString(args[0]));
      const mx = (args[1] as number) + moveOffset.x;
      const my = (args[2] as number) + moveOffset.y;
      try {
        const { ipcRenderer } = require('electron');
        await ipcRenderer.invoke('browser-tab:send-mouse-event', {
          type: 'mouseMoved', x: mx, y: my, button: 'none',
        });
        return true;
      } catch (err) {
        console.warn('[HostBridgeIpcRenderer] moveMouse error:', err);
        return false;
      }
    }

    case 'resolve:dragFromTo': {
      const dragOffset = getIframeOffset(asString(args[0]));
      const fromX = (args[1] as number) + dragOffset.x;
      const fromY = (args[2] as number) + dragOffset.y;
      const toX = (args[3] as number) + dragOffset.x;
      const toY = (args[4] as number) + dragOffset.y;
      try {
        const { ipcRenderer } = require('electron');
        await ipcRenderer.invoke('browser-tab:send-mouse-event', { type: 'mousePressed', x: fromX, y: fromY, button: 'left' });
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = fromX + (toX - fromX) * (i / steps);
          const my = fromY + (toY - fromY) * (i / steps);
          await ipcRenderer.invoke('browser-tab:send-mouse-event', { type: 'mouseMoved', x: mx, y: my, button: 'left' });
        }
        await ipcRenderer.invoke('browser-tab:send-mouse-event', { type: 'mouseReleased', x: toX, y: toY, button: 'left' });
        return true;
      } catch (err) {
        console.warn('[HostBridgeIpcRenderer] dragFromTo error:', err);
        return false;
      }
    }

    case 'resolve:scrollAtCoordinate': {
      const x = args[1] as number;
      const y = args[2] as number;
      const deltaX = args[3] as number;
      const deltaY = args[4] as number;
      try {
        const bridge = hostBridgeRegistry.resolve(asString(args[0]));
        if (bridge) {
          // Use JS scrollBy via bridge — more reliable than CDP scroll
          await bridge.execInPage(`window.scrollBy(${deltaX}, ${deltaY})`);
          return true;
        }
        return false;
      } catch (err) {
        console.warn('[HostBridgeIpcRenderer] scrollAtCoordinate error:', err);
        return false;
      }
    }

    case 'resolve:typeText': {
      const text = args[1] as string;
      try {
        const { ipcRenderer } = require('electron');
        for (const char of text) {
          await ipcRenderer.invoke('browser-tab:send-input-event', { key: char, type: 'keyDown' });
          await ipcRenderer.invoke('browser-tab:send-input-event', { key: char, type: 'char' });
          await ipcRenderer.invoke('browser-tab:send-input-event', { key: char, type: 'keyUp' });
        }
        return true;
      } catch (err) {
        console.warn('[HostBridgeIpcRenderer] typeText error:', err);
        return false;
      }
    }

    case 'resolve:annotateElements': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));
      if (!bridge) return [];
      return await bridge.execInPage(`
        (function() {
          // Remove existing annotations
          document.querySelectorAll('[data-sulla-annotation]').forEach(el => el.remove());
          const interactive = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [tabindex], [onclick]');
          const results = [];
          let index = 1;
          for (const el of interactive) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.top > window.innerHeight || rect.bottom < 0) continue;
            const label = el.textContent?.trim().slice(0, 30) || el.getAttribute('aria-label') || el.tagName.toLowerCase();
            // Create overlay
            const overlay = document.createElement('div');
            overlay.setAttribute('data-sulla-annotation', String(index));
            overlay.style.cssText = 'position:fixed;border:2px solid #ff4444;background:rgba(255,68,68,0.1);pointer-events:none;z-index:999999;' +
              'top:' + rect.top + 'px;left:' + rect.left + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';
            const badge = document.createElement('span');
            badge.style.cssText = 'position:absolute;top:-10px;left:-4px;background:#ff4444;color:white;font-size:10px;padding:1px 4px;border-radius:4px;font-weight:bold;';
            badge.textContent = String(index);
            overlay.appendChild(badge);
            document.body.appendChild(overlay);
            results.push({ index, label, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: Math.round(rect.width), height: Math.round(rect.height) });
            index++;
            if (index > 50) break;
          }
          return results;
        })()
      `);
    }

    case 'resolve:removeAnnotations': {
      const bridge = hostBridgeRegistry.resolve(asString(args[0]));
      if (bridge) {
        await bridge.execInPage(`document.querySelectorAll('[data-sulla-annotation]').forEach(el => el.remove())`);
      }
      return;
    }

    // ── Tab management ──

    case 'closeTabByAssetId': {
      const assetId = asString(args[0]);
      if (!assetId) return false;
      // Unregister from bridge registry
      hostBridgeRegistry.unregisterBridge(assetId);
      // Close the actual browser tab
      return closeTabByAssetId(assetId);
    }

    default:
      throw new Error(`Unknown bridge method: ${ method }`);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
