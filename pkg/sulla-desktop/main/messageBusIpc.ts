// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// messageBusIpc.ts — Electron IPC bridge for the in-process message bus
// Registers ipcMain handlers so renderer windows can send/receive messages
// through the main-process IpcMessageBus.

import type { IpcController, IpcMainRegistrar } from './ipc/IpcController';

/** The IpcMessageBus surface this controller uses. */
export interface MessageBusPort {
  dispatch(channelId: string, message: unknown): unknown;
  send(connectionId: string, message: unknown): Promise<boolean>;
}

export interface MessageBusIpcDependencies {
  bus(): MessageBusPort;
  allWebContents(): { id: number }[];
  send(wc: any, channel: string, ...args: unknown[]): void;
  log(...args: unknown[]): void;
}

/** message-bus:* — bridges renderer windows into the main-process message bus. */
export class MessageBusIpcController implements IpcController {
  /** webContentsId -> set of channel names the renderer has subscribed to */
  private readonly subscriptions = new Map<number, Set<string>>();

  constructor(private readonly ipc: IpcMainRegistrar, private readonly deps: MessageBusIpcDependencies) {}

  /**
   * Broadcast a message to all renderer contexts subscribed to the given channel,
   * optionally excluding one sender (to avoid echo).
   *
   * Uses webContents.getAllWebContents() so that WebContentsView instances
   * (e.g. the side panel) receive messages — not just BrowserWindows.
   */
  broadcastToRenderers(channelId: string, message: unknown, excludeWebContentsId?: number): void {
    for (const wc of this.deps.allWebContents()) {
      const wcId = wc.id;
      if (wcId === excludeWebContentsId) continue;
      const channels = this.subscriptions.get(wcId);
      if (channels?.has(channelId)) {
        this.deps.send(wc, 'message-bus:message', channelId, message);
      }
    }
  }

  register(): void {
    const bus = this.deps.bus();

    // Renderer -> Main: send a message on a channel
    this.ipc.on('message-bus:send', (event, channelId: string, message: any) => {
      // Dispatch into the main-process bus
      bus.dispatch(channelId, message);
      // Broadcast to other renderer windows (not back to sender)
      this.broadcastToRenderers(channelId, message, event.sender.id);
    });

    // Renderer -> Main: register interest in a channel
    this.ipc.handle('message-bus:connect', (event, channelId: string) => {
      const wcId = event.sender.id;
      let channels = this.subscriptions.get(wcId);
      if (!channels) {
        channels = new Set();
        this.subscriptions.set(wcId, channels);

        // Clean up when the webContents is destroyed
        event.sender.once('destroyed', () => {
          this.subscriptions.delete(wcId);
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
      this.broadcastToRenderers(connectionId, msg);

      return result;
    };

    this.deps.log('[MessageBusIpc] IPC bridge initialized');
  }
}
