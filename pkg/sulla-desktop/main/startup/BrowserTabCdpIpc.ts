// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { markSyntheticInput } from '@pkg/main/browserTabs/syntheticInput';
import Logging from '@pkg/utils/logging';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';

const console = Logging.sulla;

/** Frame script execution and trusted keyboard, mouse and screenshot input via the Chrome DevTools Protocol. */
export class BrowserTabCdpIpc implements MainProcessIpcStep {
  readonly name = 'browser-tab-cdp';

  async register(ctx: MainProcessIpcContext): Promise<void> {
    const { ipc } = ctx;

    // Execute JavaScript in a child frame (used by BrowserTab iframe bridge injection).
    // When targetUrl is provided, only executes in the frame whose URL matches.
    // Without targetUrl, executes in the first frame that succeeds (legacy behavior).
    ipc.handle('browser-tab:exec-in-frame', async(event: Electron.IpcMainInvokeEvent, code: string, targetUrl?: string) => {
      const sender = event.sender;
      const frames = sender.mainFrame.frames;

      // If a target URL is specified, find the matching frame
      if (targetUrl) {
        const targetOrigin = new URL(targetUrl).origin;
        for (const frame of frames) {
          try {
            const frameUrl = frame.url;
            if (frameUrl && new URL(frameUrl).origin === targetOrigin) {
              return await frame.executeJavaScript(code, true);
            }
          } catch { /* skip frames that error */ }
        }
      }

      // Fallback: try all frames (legacy behavior for single-tab usage)
      for (const frame of frames) {
        try {
          return await frame.executeJavaScript(code, true);
        } catch (err) {
          console.warn('[Sulla] browser-tab:exec-in-frame error on frame:', err);
        }
      }

      return undefined;
    });

    // Send trusted keyboard input via Chrome DevTools Protocol (CDP).
    // CDP Input.dispatchKeyEvent produces isTrusted=true events that work
    // inside iframes — unlike sendInputEvent which only targets the top frame.
    ipc.handle('browser-tab:send-input-event', async(event: Electron.IpcMainInvokeEvent, inputEvent: { key: string; type: 'keyDown' | 'keyUp' | 'char' }, tabId?: string) => {
      let wc: Electron.WebContents;

      if (tabId) {
        const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
        const mgr = BrowserTabViewManager.getInstance();
        const viewWc = mgr.getWebContents(tabId);

        if (!viewWc) return false;
        const owner = agentWindowFromSender(event.sender);
        if (!owner || !mgr.ownsTab(tabId, owner)) throw new Error(`Browser tab "${ tabId }" is not owned by this window`);
        mgr.wakeView(tabId);
        wc = viewWc;
      } else {
        wc = event.sender;
      }

      try {
        // Attach debugger if not already attached
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
        }

        const keyCodeMap: Record<string, { code: string; keyCode: number; text?: string }> = {
          Enter:      { code: 'Enter', keyCode: 13, text: '\r' },
          Escape:     { code: 'Escape', keyCode: 27 },
          Tab:        { code: 'Tab', keyCode: 9 },
          Space:      { code: 'Space', keyCode: 32, text: ' ' },
          Backspace:  { code: 'Backspace', keyCode: 8 },
          ArrowUp:    { code: 'ArrowUp', keyCode: 38 },
          ArrowDown:  { code: 'ArrowDown', keyCode: 40 },
          ArrowLeft:  { code: 'ArrowLeft', keyCode: 37 },
          ArrowRight: { code: 'ArrowRight', keyCode: 39 },
        };

        const mapped = keyCodeMap[inputEvent.key] || { code: inputEvent.key, keyCode: 0 };

        const cdpType = inputEvent.type === 'char'
          ? 'char'
          : inputEvent.type === 'keyUp' ? 'keyUp' : 'rawKeyDown';

        const params: Record<string, unknown> = {
          type:                  cdpType,
          key:                   inputEvent.key,
          code:                  mapped.code,
          windowsVirtualKeyCode: mapped.keyCode,
          nativeVirtualKeyCode:  mapped.keyCode,
        };
        if (cdpType === 'char' && mapped.text) {
          params.text = mapped.text;
          params.unmodifiedText = mapped.text;
        }

        markSyntheticInput(wc);
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', params);
        return true;
      } catch (err) {
        console.warn('[Sulla] browser-tab:send-input-event CDP error:', err);
        return false;
      }
    });

    // ── Screenshot capture via CDP ───────────────────────────────────────────
    ipc.handle('browser-tab:capture-screenshot', async(event: Electron.IpcMainInvokeEvent, options?: {
      format?:  'jpeg' | 'png';
      quality?: number;
      clip?:    { x: number; y: number; width: number; height: number; scale?: number };
    }, tabId?: string) => {
      let wc: Electron.WebContents;

      if (tabId) {
        const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
        const mgr = BrowserTabViewManager.getInstance();
        const viewWc = mgr.getWebContents(tabId);

        if (!viewWc) return null;
        const owner = agentWindowFromSender(event.sender);
        if (!owner || !mgr.ownsTab(tabId, owner)) throw new Error(`Browser tab "${ tabId }" is not owned by this window`);
        mgr.wakeView(tabId);
        wc = viewWc;
      } else {
        wc = event.sender;
      }

      try {
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
        }

        const cdpParams: Record<string, unknown> = {
          format:                options?.format ?? 'jpeg',
          quality:               options?.quality ?? 80,
          captureBeyondViewport: false,
        };

        if (options?.clip) {
          cdpParams.clip = {
            x:      options.clip.x,
            y:      options.clip.y,
            width:  options.clip.width,
            height: options.clip.height,
            scale:  options.clip.scale ?? 1,
          };
        }

        const result = await wc.debugger.sendCommand('Page.captureScreenshot', cdpParams);

        return {
          base64:    result.data as string,
          mediaType: `image/${ cdpParams.format }`,
        };
      } catch (err) {
        console.warn('[Sulla] browser-tab:capture-screenshot CDP error:', err);
        return null;
      }
    });

    // ── Mouse events via CDP ────────────────────────────────────────────────
    ipc.handle('browser-tab:send-mouse-event', async(event: Electron.IpcMainInvokeEvent, mouseEvent: {
      type:        'mousePressed' | 'mouseReleased' | 'mouseMoved';
      x:           number;
      y:           number;
      button?:     'left' | 'right' | 'middle' | 'none';
      clickCount?: number;
    }, tabId?: string) => {
      let wc: Electron.WebContents;

      if (tabId) {
        const { BrowserTabViewManager } = await import('@pkg/window/browserTabViewManager');
        const mgr = BrowserTabViewManager.getInstance();
        const viewWc = mgr.getWebContents(tabId);

        if (!viewWc) return false;
        const owner = agentWindowFromSender(event.sender);
        if (!owner || !mgr.ownsTab(tabId, owner)) throw new Error(`Browser tab "${ tabId }" is not owned by this window`);
        mgr.wakeView(tabId);
        wc = viewWc;
      } else {
        wc = event.sender;
      }

      try {
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
        }

        markSyntheticInput(wc);
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type:       mouseEvent.type,
          x:          mouseEvent.x,
          y:          mouseEvent.y,
          button:     mouseEvent.button ?? 'left',
          clickCount: mouseEvent.clickCount ?? 1,
        });

        return true;
      } catch (err) {
        console.warn('[Sulla] browser-tab:send-mouse-event CDP error:', err);
        return false;
      }
    });
  }
}
