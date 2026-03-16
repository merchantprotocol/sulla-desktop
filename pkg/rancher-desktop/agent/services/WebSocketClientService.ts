// WebSocketClientService.ts - Fixed version (all TS errors resolved)

export interface WebSocketMessage {
  type:        string;
  data:        unknown;
  id:          string;
  originalId?: string;
  timestamp:   number;
  channel?:    string;
}

export type WebSocketMessageHandler = (message: WebSocketMessage) => void;
export type ConnectHandler = () => void;

interface ConnectionConfig {
  url:                   string;
  channel?:              string;
  reconnectInterval?:    number;
  maxReconnectAttempts?: number;
  ackTimeout?:           number;
  maxMessageAgeMs?:      number;
}

const DEFAULT_WS_URL = 'ws://localhost:30118/';

/**
 * Shared readiness gate — resolves once the WebSocket hub on port 30118
 * accepts a connection for the first time.  All channel connections created
 * via WebSocketClientService.connect() are deferred until this gate opens,
 * eliminating the noisy retry storm during startup.
 */
let hubReadyResolve: (() => void) | null = null;
let hubReady: Promise<void> | null = null;
let hubProbeRunning = false;

function getHubReadyPromise(): Promise<void> {
  if (!hubReady) {
    hubReady = new Promise<void>((resolve) => {
      hubReadyResolve = resolve;
    });
  }
  return hubReady;
}

/** Mark the hub as ready from the outside (e.g. after startup probe succeeds). */
export function markHubReady(): void {
  if (hubReadyResolve) {
    hubReadyResolve();
    hubReadyResolve = null;
  } else if (!hubReady) {
    hubReady = Promise.resolve();
  }
}

/** Probe the hub with a single WebSocket connection attempt.  Retries every 3 s until
 *  the connection succeeds, then calls markHubReady().  Safe to call multiple times —
 *  only the first invocation spawns a probe loop. */
function probeHubUntilReady(): void {
  if (hubProbeRunning) return;
  hubProbeRunning = true;

  const attempt = () => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(DEFAULT_WS_URL);
    } catch {
      setTimeout(attempt, 3000);
      return;
    }

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      setTimeout(attempt, 3000);
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      console.log('[WSService] Hub probe succeeded — marking ready');
      markHubReady();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      setTimeout(attempt, 3000);
    };
  };

  attempt();
}

function generateUUID(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback random fill
    for (let i = 0; i < 16; i++) {
      bytes[i] = (Math.random() * 256) | 0;
    }
  }

  // Set version 4 bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant bits
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

class WebSocketConnection {
  public ws: WebSocket | null = null;
  public pending = new Map<string, {
    message:       WebSocketMessage;
    queuedAt:      number;
    firstSentAt:   number;
    lastSentAt?:   number;
    attempts:      number;
    timeoutTimer?: NodeJS.Timeout;
    resolve?:      (acked: boolean) => void;
    reject?:       (err: Error) => void;
  }>();

  public heartbeatTimer: NodeJS.Timeout | null = null;
  public reconnectTimer: NodeJS.Timeout | null = null;
  public reconnectAttempts = 0;
  public messageHandlers = new Set<WebSocketMessageHandler>();
  public subscribed = new Set<string>();

  private config: Required<ConnectionConfig>;

  constructor(config: ConnectionConfig) {
    this.config = {
      ...config,  // user overrides come first
      url:                  config.url,
      channel:              config.channel || '',
      reconnectInterval:    4000,
      maxReconnectAttempts: 1200,
      ackTimeout:           9000,
      maxMessageAgeMs:      240_000,
    };
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    // If a reconnect timer is already scheduled, don't spawn a parallel attempt
    if (this.reconnectTimer) return;

    this.cleanup();

    try {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        console.log(`[WS ${ this.config.channel }] Connected`);
        this.reconnectAttempts = 0;
        if (this.config.channel && !this.subscribed.has(this.config.channel)) {
          this.sendNow({
            type:      'subscribe',
            data:      null,                    // required field
            channel:   this.config.channel,
            id:        generateUUID(),
            timestamp: Date.now(),
          });
          this.subscribed.add(this.config.channel);
        }
        this.startHeartbeat();
        this.retryPending();
      };

      this.ws.onmessage = async(event) => {
        const text = event.data instanceof Blob ? await event.data.text() : event.data as string;
        let msg: WebSocketMessage;

        try {
          msg = JSON.parse(text);
        } catch {
          const fallbackIdMatch = /"id":"([a-f0-9-]+)"/i.exec(text);
          if (fallbackIdMatch) this.ack(fallbackIdMatch[1]);
          return;
        }

        if (msg.type === 'ack' && msg.originalId) {
          this.clearPending(msg.originalId);
          return;
        }

        if (msg.id) this.ack(msg.id);

        this.messageHandlers.forEach(h => {
          try { h(msg) } catch (e) { console.error('[WS handler error]', e) }
        });
      };

      this.ws.onerror = () => this.scheduleReconnect();
      this.ws.onclose = () => this.scheduleReconnect();
    } catch {
      this.scheduleReconnect();
    }
  }

  private ack(originalId: string) {
    this.sendNow({
      type:      'ack',
      originalId,
      data:      null,
      id:        generateUUID(),
      timestamp: Date.now(),
      channel:   this.config.channel,
    });
  }

  private sendNow(msg: WebSocketMessage) {
    if (this.isConnected()) {
      try { this.ws!.send(JSON.stringify(msg)) } catch {}
    }
  }

  private clearPending(id: string) {
    const entry = this.pending.get(id);
    if (entry?.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry?.resolve?.(true);
    this.pending.delete(id);
  }

  private cleanup() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.subscribed.clear();
  }

  private rejectAllPending(reason: string) {
    const err = new Error(reason);
    for (const [id, entry] of this.pending.entries()) {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      entry.reject?.(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect() {
    this.cleanup();

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.warn(`[WS ${ this.config.channel }] Max reconnect attempts reached`);
      this.rejectAllPending('Max reconnect attempts reached — server unreachable');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.config.reconnectInterval * (1.618 ** this.reconnectAttempts) + Math.random() * 600, 45000);
    console.log(`[WS ${ this.config.channel }] Reconnect attempt ${ this.reconnectAttempts } in ${ Math.round(delay / 1000) }s`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected()) {
        // Send heartbeat on dedicated heartbeat channel, not the data channel
        this.sendNow({
          type:      'ping',
          data:      null,
          channel:   'heartbeat', // Dedicated heartbeat channel
          id:        generateUUID(),
          timestamp: Date.now(),
        });
      }
    }, 30000);
  }

  private retryPending() {
    if (!this.isConnected()) return;

    const now = Date.now();
    for (const [id, entry] of [...this.pending.entries()]) {
      if (now - entry.queuedAt > this.config.maxMessageAgeMs) {
        console.warn(`[WS ${ this.config.channel }] Dropping aged message ${ id } (age ${ (now - entry.queuedAt) / 1000 | 0 }s)`);
        entry.reject?.(new Error('Message expired without server ack'));
        this.pending.delete(id);
        continue;
      }

      if (entry.timeoutTimer) continue;

      try {
        this.ws!.send(JSON.stringify(entry.message));
        entry.lastSentAt = now;
        entry.attempts++;

        entry.timeoutTimer = setTimeout(() => {
          entry.timeoutTimer = undefined;
          if (this.isConnected()) this.retryPending();
        }, this.config.ackTimeout * (1.5 ** Math.min(entry.attempts, 7)));

        if (entry.attempts >= 8 && this.pending.size > 12) {
          console.warn(`[WS ${ this.config.channel }] Emergency reconnect - ${ this.pending.size } pending, high retry`);
          this.scheduleReconnect();
          return;
        }
      } catch {}
    }
  }

  send(message: Omit<WebSocketMessage, 'timestamp'> & { id?: string }): Promise<boolean> {
    const fullMsg: WebSocketMessage = {
      ...message,
      id:        message.id ?? generateUUID(),
      timestamp: Date.now(),
      channel:   message.channel ?? this.config.channel,
    };

    if (this.pending.has(fullMsg.id)) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve, reject) => {
      this.pending.set(fullMsg.id, {
        message:     fullMsg,
        queuedAt:    Date.now(),
        firstSentAt: 0,
        attempts:    0,
        resolve,
        reject,
      });

      if (this.isConnected()) this.retryPending();
    });
  }

  onMessage(handler: WebSocketMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isConnecting(): boolean {
    return this.ws?.readyState === WebSocket.CONNECTING;
  }

  disconnect(): void {
    this.cleanup();
    this.rejectAllPending('WebSocket disconnected');
    this.subscribed.clear();
    this.reconnectAttempts = 0;
  }
}

export class WebSocketClientService {
  private connections = new Map<string, WebSocketConnection>();

  // Make it static and properly typed
  private static instance: WebSocketClientService | null = null;

  // Now this works correctly
  public static getInstance(): WebSocketClientService {
    if (!WebSocketClientService.instance) {
      WebSocketClientService.instance = new WebSocketClientService();
    }
    return WebSocketClientService.instance;
  }

  connect(connectionId: string, url: string = DEFAULT_WS_URL): boolean {
    let conn = this.connections.get(connectionId);
    if (conn) {
      // Important: keep an in-flight connection attempt alive.
      // Multiple startup callers (persona + frontend graph + scheduler) can call connect
      // for the same channel during bootstrap; disconnecting CONNECTING sockets causes
      // "WebSocket is closed before the connection is established" and first-message delays.
      if (conn.isConnected() || conn.isConnecting()) return true;
      // Reuse the same connection instance so existing onMessage handlers remain attached.
      this.connectWhenReady(conn);
      return true;
    }

    conn = new WebSocketConnection({ url, channel: connectionId });
    this.connections.set(connectionId, conn);
    // Attach debug tap handler
    conn.onMessage((msg) => this.logMessage(connectionId, 'in', msg));
    this.connectWhenReady(conn);
    return true;
  }

  /** Wait for the hub readiness probe before opening the actual WebSocket. */
  private connectWhenReady(conn: WebSocketConnection): void {
    // Kick off the hub probe (no-op if already running)
    probeHubUntilReady();
    getHubReadyPromise().then(() => conn.connect());
  }

  async send(connectionId: string, message: unknown): Promise<boolean> {
    const msgType = (message as any)?.type || '(unknown)';
    console.log(`[WSService] send() — channel="${ connectionId }", type="${ msgType }"`);

    let conn = this.connections.get(connectionId);
    if (!conn?.isConnected()) {
      console.log(`[WSService] send() — channel="${ connectionId }" not connected, connecting...`);
      this.connect(connectionId);
      conn = this.connections.get(connectionId);
      if (!conn) {
        console.error(`[WSService] send() — failed to create connection for "${ connectionId }"`);
        return false;
      }

      // Wait for connection to establish
      let attempts = 0;
      const maxAttempts = 50; // 5 seconds
      while (!conn.isConnected() && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      if (!conn.isConnected()) {
        console.error(`[WSService] send() — connection timeout for "${ connectionId }" after ${ attempts * 100 }ms`);
        return false;
      }
      console.log(`[WSService] send() — channel="${ connectionId }" connected after ${ attempts * 100 }ms`);
    }

    try {
      if (typeof message === 'object' && message && 'type' in message) {
        this.logMessage(connectionId, 'out', message as WebSocketMessage);
        return await conn.send(message as any);
      } else {
        const outMsg = { type: 'message', data: message, id: generateUUID(), timestamp: Date.now() };
        this.logMessage(connectionId, 'out', outMsg);
        return await conn.send(outMsg as any);
      }
    } catch (err) {
      console.error(`[WS ${ connectionId }] Send failed:`, (err as Error).message);
      return false;
    }
  }

  onMessage(connectionId: string, handler: WebSocketMessageHandler): (() => void) | null {
    return this.connections.get(connectionId)?.onMessage(handler) ?? null;
  }

  isConnected(connectionId: string): boolean {
    return this.connections.get(connectionId)?.isConnected() ?? false;
  }

  disconnect(connectionId: string): void {
    this.connections.get(connectionId)?.disconnect();
    this.connections.delete(connectionId);
  }

  disconnectAll(): void {
    this.connections.forEach(c => c.disconnect());
    this.connections.clear();
  }

  getPendingCount(connectionId: string): number {
    return this.connections.get(connectionId)?.pending.size ?? 0;
  }

  /** Ring buffer of recent messages across all connections for debug tap */
  private messageLog: { connectionId: string; direction: 'in' | 'out'; message: WebSocketMessage; ts: number }[] = [];
  private static MAX_MESSAGE_LOG = 500;
  private tapping = false;

  /** Enable/disable message logging for debug UI */
  setTapping(enabled: boolean): void { this.tapping = enabled; if (!enabled) this.messageLog = []; }

  /** Record a message to the debug ring buffer */
  private logMessage(connectionId: string, direction: 'in' | 'out', message: WebSocketMessage): void {
    if (!this.tapping) return;
    this.messageLog.push({ connectionId, direction, message, ts: Date.now() });
    if (this.messageLog.length > WebSocketClientService.MAX_MESSAGE_LOG) {
      this.messageLog = this.messageLog.slice(-WebSocketClientService.MAX_MESSAGE_LOG);
    }
  }

  /** Get recent messages for a connection (or all if connectionId is empty) */
  getRecentMessages(connectionId?: string, limit = 100): { connectionId: string; direction: 'in' | 'out'; message: WebSocketMessage; ts: number }[] {
    const msgs = connectionId ? this.messageLog.filter(m => m.connectionId === connectionId) : this.messageLog;
    return msgs.slice(-limit);
  }

  getConnectionStats(): Record<string, { connected: boolean; reconnectAttempts: number; pendingMessages: number; subscribedChannels: string[] }> {
    const stats: Record<string, { connected: boolean; reconnectAttempts: number; pendingMessages: number; subscribedChannels: string[] }> = {};
    for (const [id, conn] of this.connections) {
      stats[id] = {
        connected:          conn.isConnected(),
        reconnectAttempts:  conn.reconnectAttempts,
        pendingMessages:    conn.pending.size,
        subscribedChannels: Array.from(conn.subscribed),
      };
    }
    return stats;
  }
}

export const getWebSocketClientService = () => WebSocketClientService.getInstance();
