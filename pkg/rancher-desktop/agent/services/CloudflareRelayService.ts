/**
 * CloudflareRelayService
 *
 * Maintains an outbound WebSocket to a Cloudflare Durable Object that relays
 * chat requests from a paired mobile client to this desktop. On inbound
 * `{type:"chat", messages:[...]}` messages, the service invokes the local
 * chatCompletions pipeline and sends the response back as `{type:"done"}`.
 *
 * Mirrors the auto-reconnect pattern used by SlackClient / Bolt's SocketModeClient.
 */

import WebSocket from 'ws';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import { getChatCompletionsServer } from '@pkg/main/chatCompletionsServer';

const DEFAULT_RELAY_URL = 'wss://sulla-workers.jonathon-44b.workers.dev';
const DEFAULT_ROOM = 'sulla-dev-room';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class CloudflareRelayService {
  private static instance: CloudflareRelayService | null = null;

  private ws:             WebSocket | null = null;
  private connected = false;
  private intentionallyClosed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): CloudflareRelayService {
    if (!CloudflareRelayService.instance) {
      CloudflareRelayService.instance = new CloudflareRelayService();
    }
    return CloudflareRelayService.instance;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.intentionallyClosed = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000) } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  private async connect(): Promise<void> {
    if (this.intentionallyClosed) return;

    const relayUrl = await SullaSettingsModel.get('cloudflareRelayUrl', DEFAULT_RELAY_URL);
    const room = await SullaSettingsModel.get('cloudflareRelayRoom', DEFAULT_ROOM);
    const url = `${ relayUrl }/relay/${ encodeURIComponent(room) }?role=desktop`;

    console.log(`[CloudflareRelay] Connecting to ${ url }`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[CloudflareRelay] Connected');
      this.connected = true;
      this.reconnectAttempt = 0;
    });

    ws.on('message', (data) => {
      void this.handleMessage(data.toString());
    });

    ws.on('error', (err: Error) => {
      console.error('[CloudflareRelay] Error:', err.message);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      console.warn(`[CloudflareRelay] Closed (${ code }): ${ reason.toString() }`);
      this.connected = false;
      this.ws = null;
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyClosed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    console.log(`[CloudflareRelay] Reconnecting in ${ delay }ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg?.type === 'connected') return;
    if (msg?.type !== 'chat') return;

    const messages = Array.isArray(msg.messages) ? msg.messages : [];
    if (messages.length === 0) return;

    try {
      const server = getChatCompletionsServer();
      const text = await server.processChat(messages);
      this.send({ type: 'done', content: text });
    } catch (e: any) {
      console.error('[CloudflareRelay] Error processing chat:', e);
      this.send({ type: 'error', reason: e?.message || 'processing_failed' });
    }
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      console.error('[CloudflareRelay] Send failed:', e);
    }
  }
}

export function getCloudflareRelayService(): CloudflareRelayService {
  return CloudflareRelayService.getInstance();
}
