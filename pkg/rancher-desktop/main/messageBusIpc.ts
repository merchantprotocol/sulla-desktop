// messageBusIpc.ts — Electron IPC bridge for the in-process message bus
// Registers ipcMain handlers so renderer windows can send/receive messages
// through the main-process IpcMessageBus.

import { BrowserWindow, ipcMain, webContents } from 'electron';
import Logging from '@pkg/utils/logging';
import { IpcMessageBus } from '@pkg/agent/services/IpcMessageBus';

const console = Logging.background;

/** webContentsId -> set of channel names the renderer has subscribed to */
const subscriptions = new Map<number, Set<string>>();

/**
 * Broadcast a message to all renderer contexts subscribed to the given channel,
 * optionally excluding one sender (to avoid echo).
 *
 * Uses webContents.getAllWebContents() so that WebContentsView instances
 * (e.g. the side panel) receive messages — not just BrowserWindows.
 */
function broadcastToRenderers(channelId: string, message: unknown, excludeWebContentsId?: number): void {
  for (const wc of webContents.getAllWebContents()) {
    const wcId = wc.id;
    if (wcId === excludeWebContentsId) continue;
    const channels = subscriptions.get(wcId);
    if (channels && channels.has(channelId)) {
      try {
        if (!wc.isDestroyed()) {
          wc.send('message-bus:message', channelId, message);
        }
      } catch {
        // webContents was destroyed between check and send
      }
    }
  }
}

export function initMessageBusIpc(): void {
  const bus = IpcMessageBus.getInstance();

  // Renderer -> Main: send a message on a channel
  ipcMain.on('message-bus:send', (event, channelId: string, message: any) => {
    // Dispatch into the main-process bus
    bus.dispatch(channelId, message);
    // Broadcast to other renderer windows (not back to sender)
    broadcastToRenderers(channelId, message, event.sender.id);
  });

  // Renderer -> Main: register interest in a channel
  ipcMain.handle('message-bus:connect', (event, channelId: string) => {
    const wcId = event.sender.id;
    let channels = subscriptions.get(wcId);
    if (!channels) {
      channels = new Set();
      subscriptions.set(wcId, channels);

      // Clean up when the webContents is destroyed
      event.sender.once('destroyed', () => {
        subscriptions.delete(wcId);
      });
    }
    channels.add(channelId);
    return true;
  });

  // Monkey-patch bus.send() so main-process messages also reach renderer windows
  const originalSend = bus.send.bind(bus);
  bus.send = async(connectionId: string, message: unknown): Promise<boolean> => {
    const result = await originalSend(connectionId, message);
    // After dispatching in main, also broadcast to all subscribed renderers
    // Normalize the message for broadcast
    const msg = typeof message === 'object' && message && 'type' in message ? message : { type: 'message', data: message };
    broadcastToRenderers(connectionId, msg);
    return result;
  };

  console.log('[MessageBusIpc] IPC bridge initialized');
}
