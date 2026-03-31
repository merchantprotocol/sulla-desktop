// IpcMessageBusRenderer.ts — Renderer-process IPC message bus
// Bridges messages between the renderer and main process via Electron IPC.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { WebSocketMessage, WebSocketMessageHandler } from './WebSocketClientService';

function generateUUID(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = (Math.random() * 256) | 0;
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

export class IpcMessageBusRenderer {
  private static instance: IpcMessageBusRenderer | null = null;
  private channels = new Map<string, Set<WebSocketMessageHandler>>();

  /** Ring buffer for debug tap */
  private messageLog: { connectionId: string; direction: 'in' | 'out'; message: WebSocketMessage; ts: number }[] = [];
  private static MAX_MESSAGE_LOG = 500;
  private tapping = false;

  private constructor() {
    // Listen for messages broadcast from the main process
    (ipcRenderer as any).on('message-bus:message', (_event: any, channelId: string, message: WebSocketMessage) => {
      this.logMessage(channelId, 'in', message);
      const handlers = this.channels.get(channelId);
      if (!handlers) return;
      for (const h of handlers) {
        try {
          h(message);
        } catch (e) {
          console.error('[IpcMessageBusRenderer] handler error:', e);
        }
      }
    });
  }

  static getInstance(): IpcMessageBusRenderer {
    if (!IpcMessageBusRenderer.instance) {
      IpcMessageBusRenderer.instance = new IpcMessageBusRenderer();
    }
    return IpcMessageBusRenderer.instance;
  }

  connect(connectionId: string, _url?: string): boolean {
    if (!this.channels.has(connectionId)) {
      this.channels.set(connectionId, new Set());
    }
    // Notify main process about channel interest
    (ipcRenderer as any).invoke('message-bus:connect', connectionId).catch(() => {});
    return true;
  }

  async send(connectionId: string, message: unknown): Promise<boolean> {
    this.connect(connectionId);

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

    // Forward to main process which dispatches to main-side handlers
    // and broadcasts back to all subscribed renderers (including this one).
    // Do NOT dispatch locally here — the broadcast handles delivery to
    // avoid double-delivery.
    (ipcRenderer as any).send('message-bus:send', connectionId, fullMsg);
    return true;
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
    this.channels.delete(connectionId);
  }

  disconnectAll(): void {
    this.channels.clear();
  }

  markSuspended(): void {
    // No-op
  }

  forceReconnectAll(): void {
    // No-op
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
    if (this.messageLog.length > IpcMessageBusRenderer.MAX_MESSAGE_LOG) {
      this.messageLog = this.messageLog.slice(-IpcMessageBusRenderer.MAX_MESSAGE_LOG);
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
