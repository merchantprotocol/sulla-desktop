// IpcMessageBus.ts — Main-process in-memory message bus
// Drop-in replacement for WebSocketClientService that routes messages
// through Electron IPC instead of an external Docker WebSocket hub.

import { wsLogger as console } from '@pkg/agent/utils/agentLogger';
import type { WebSocketMessage, WebSocketMessageHandler } from './WebSocketClientService';

function generateUUID(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = (Math.random() * 256) | 0;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

export class IpcMessageBus {
  private static instance: IpcMessageBus | null = null;
  private channels = new Map<string, Set<WebSocketMessageHandler>>();

  /** Ring buffer of recent messages for debug tap */
  private messageLog: { connectionId: string; direction: 'in' | 'out'; message: WebSocketMessage; ts: number }[] = [];
  private static MAX_MESSAGE_LOG = 500;
  private tapping = false;

  static getInstance(): IpcMessageBus {
    if (!IpcMessageBus.instance) {
      IpcMessageBus.instance = new IpcMessageBus();
    }
    return IpcMessageBus.instance;
  }

  connect(connectionId: string, _url?: string): boolean {
    if (!this.channels.has(connectionId)) {
      this.channels.set(connectionId, new Set());
      console.log(`[IpcMessageBus] Channel registered: "${ connectionId }"`);
    }
    return true;
  }

  async send(connectionId: string, message: unknown): Promise<boolean> {
    // Ensure channel exists
    this.connect(connectionId);

    // Normalize into WebSocketMessage
    let fullMsg: WebSocketMessage;
    if (typeof message === 'object' && message && 'type' in message) {
      const m = message as Partial<WebSocketMessage>;
      fullMsg = {
        type:      m.type || 'message',
        data:      m.data ?? null,
        id:        m.id || generateUUID(),
        timestamp: m.timestamp || Date.now(),
        channel:   m.channel || connectionId,
      };
    } else {
      fullMsg = {
        type:      'message',
        data:      message,
        id:        generateUUID(),
        timestamp: Date.now(),
        channel:   connectionId,
      };
    }

    this.logMessage(connectionId, 'out', fullMsg);
    this.dispatch(connectionId, fullMsg);

    // Forward to all renderer windows so IpcMessageBusRenderer receives the message.
    // This bridges main-process tool calls (browser_tab, etc.) to the renderer's
    // AgentPersonaModel which handles tab creation, asset registration, etc.
    try {
      const { BrowserWindow } = require('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('message-bus:message', connectionId, fullMsg);
        }
      }
    } catch { /* electron not available — running in non-electron context */ }

    return true;
  }

  /**
   * Dispatch a message to all handlers registered on a channel.
   * Called internally by send() and externally by the IPC bridge
   * when renderer windows forward messages.
   */
  dispatch(channelId: string, message: WebSocketMessage): void {
    this.logMessage(channelId, 'in', message);
    const handlers = this.channels.get(channelId);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(message);
      } catch (e) {
        console.error('[IpcMessageBus] handler error:', e);
      }
    }
  }

  onMessage(connectionId: string, handler: WebSocketMessageHandler): (() => void) | null {
    this.connect(connectionId);
    const handlers = this.channels.get(connectionId)!;
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  isConnected(_connectionId: string): boolean {
    return true;
  }

  disconnect(connectionId: string): void {
    console.log(`[IpcMessageBus] disconnect — channel="${ connectionId }"`);
    this.channels.delete(connectionId);
  }

  disconnectAll(): void {
    console.log(`[IpcMessageBus] disconnectAll — ${ this.channels.size } channel(s)`);
    this.channels.clear();
  }

  markSuspended(): void {
    // No-op — IPC bus is always available
  }

  forceReconnectAll(): void {
    // No-op — IPC bus is always available
  }

  getPendingCount(_connectionId: string): number {
    return 0;
  }

  // ── Debug tap ──

  setTapping(enabled: boolean): void {
    this.tapping = enabled;
    if (!enabled) this.messageLog = [];
  }

  private logMessage(connectionId: string, direction: 'in' | 'out', message: WebSocketMessage): void {
    if (!this.tapping) return;
    this.messageLog.push({ connectionId, direction, message, ts: Date.now() });
    if (this.messageLog.length > IpcMessageBus.MAX_MESSAGE_LOG) {
      this.messageLog = this.messageLog.slice(-IpcMessageBus.MAX_MESSAGE_LOG);
    }
  }

  getRecentMessages(connectionId?: string, limit = 100): { connectionId: string; direction: 'in' | 'out'; message: WebSocketMessage; ts: number }[] {
    const msgs = connectionId ? this.messageLog.filter(m => m.connectionId === connectionId) : this.messageLog;
    return msgs.slice(-limit);
  }

  getConnectionStats(): Record<string, { connected: boolean; reconnectAttempts: number; pendingMessages: number; subscribedChannels: string[] }> {
    const stats: Record<string, { connected: boolean; reconnectAttempts: number; pendingMessages: number; subscribedChannels: string[] }> = {};
    for (const [id] of this.channels) {
      stats[id] = {
        connected:          true,
        reconnectAttempts:  0,
        pendingMessages:    0,
        subscribedChannels: [id],
      };
    }
    return stats;
  }
}
