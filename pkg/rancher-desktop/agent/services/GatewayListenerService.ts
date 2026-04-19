/**
 * GatewayListenerService — connects to the Enterprise Gateway as a listener
 * and streams desktop audio to active sessions.
 *
 * Runs in the main (background) process. Two WebSocket roles:
 *
 *   1. **Lobby listener** (`/ws/listener`) — receives session announcements,
 *      transcript events, and state changes from the gateway.
 *
 *   2. **Audio stream** (`/audio/{sessionId}`) — sends raw microphone audio
 *      to the gateway for an active desktop session.
 *
 * The renderer communicates via IPC:
 *   - `gateway-listener-start`  → connect lobby listener
 *   - `gateway-listener-stop`   → disconnect lobby listener
 *   - `gateway-listener-status` → get current connection state
 *   - `gateway-audio-start`     → create session + open audio stream
 *   - `gateway-audio-stop`      → close audio stream + end session
 *   - `gateway-audio-send`      → send a chunk of audio data
 */

import * as os from 'os';

import { getIntegrationService } from './IntegrationService';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

// Use __non_webpack_require__ to bypass webpack bundling for the ws package.
// The global WebSocket API doesn't support custom headers, which we need for
// Authorization bearer tokens on the WebSocket handshake.
declare const __non_webpack_require__: typeof require;
const WebSocket = __non_webpack_require__('ws');

// ─── Types ──────────────────────────────────────────────────────

export interface GatewayListenerState {
  lobbyConnected:         boolean;
  audioConnected:         boolean;
  sessionId:              string | null;
  callId:                 string | null;
  error:                  string | null;
  lobbyReconnectAttempts: number;
  audioReconnecting:      boolean;
}

export interface GatewayEvent {
  event_type:    string;
  sessionId?:    string;
  callId?:       string;
  state?:        string;
  timestamp?:    string;
  [key: string]: unknown;
}

type EventCallback = (event: GatewayEvent) => void;

// ─── Constants ──────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const PING_TIMEOUT_MS = 45_000; // close if no health_ping received
const AUDIO_RECONNECT_DELAY_MS = 2_000;
const AUDIO_MAX_RECONNECT_ATTEMPTS = 5;
const AUDIO_BACKPRESSURE_THRESHOLD = 64 * 1024; // 64 KB — matches gateway

// ─── Singleton ──────────────────────────────────────────────────

let instance: GatewayListenerService | null = null;

export function getGatewayListenerService(): GatewayListenerService {
  if (!instance) {
    instance = new GatewayListenerService();
  }
  return instance;
}

// ─── Service ────────────────────────────────────────────────────

export class GatewayListenerService {
  // Lobby WebSocket
  private lobbyWs:             InstanceType<typeof WebSocket> | null = null;
  private lobbyReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lobbyReconnectDelay = RECONNECT_DELAY_MS;
  private lobbyPingTimer:      ReturnType<typeof setTimeout> | null = null;
  private lobbyIntentional = false;

  // Audio WebSocket
  private audioWs:             InstanceType<typeof WebSocket> | null = null;
  private activeSessionId:     string | null = null;
  private activeCallId:        string | null = null;
  private audioReconnecting = false;
  private audioReconnectAttempts = 0;
  private audioReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private audioIntentionalClose = false;

  // Per-session listener WebSocket (receives transcript events for the active session)
  private sessionListenerWs: InstanceType<typeof WebSocket> | null = null;

  // Lobby reconnect tracking
  private lobbyReconnectAttempts = 0;

  // Event subscribers (main-process consumers)
  private listeners = new Set<EventCallback>();

  // Last error for status reporting
  private lastError: string | null = null;

  // ─── Public API ─────────────────────────────────────────────

  /** Subscribe to gateway events. Returns unsubscribe function. */
  onEvent(cb: EventCallback): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb) };
  }

  /** Connect the lobby listener WebSocket. */
  async startLobby(): Promise<void> {
    // Mark intentional so the close handler from terminate() won't schedule a reconnect
    this.lobbyIntentional = true;
    this.clearLobbyReconnect();
    this.clearPingTimer();

    // Kill any existing connection (including zombies)
    if (this.lobbyWs) {
      try { this.lobbyWs.terminate() } catch (err) { console.warn('[GatewayListener] Lobby terminate error:', err) }
      this.lobbyWs = null;
    }

    // Wait a tick so the close event from terminate() fires while lobbyIntentional is still true.
    // Without this, the close handler can race and schedule a spurious reconnect.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Now open the fresh connection
    this.lobbyIntentional = false;
    this.lobbyReconnectAttempts = 0;
    this.lobbyReconnectDelay = RECONNECT_DELAY_MS;
    this.lastError = null;
    await this.connectLobby();
  }

  /** Disconnect the lobby listener WebSocket. */
  stopLobby(): void {
    this.lobbyIntentional = true;
    this.clearLobbyReconnect();
    this.clearPingTimer();
    if (this.lobbyWs) {
      try { this.lobbyWs.terminate() } catch (err) { console.warn('[GatewayListener] Lobby terminate error:', err) }
      this.lobbyWs = null;
    }
  }

  /** Get current connection state. */
  getStatus(): GatewayListenerState {
    return {
      lobbyConnected:         this.lobbyWs?.readyState === WebSocket.OPEN,
      audioConnected:         this.audioWs?.readyState === WebSocket.OPEN,
      sessionId:              this.activeSessionId,
      callId:                 this.activeCallId,
      error:                  this.lastError,
      lobbyReconnectAttempts: this.lobbyReconnectAttempts,
      audioReconnecting:      this.audioReconnecting,
    };
  }

  /**
   * Create a gateway session and open an audio WebSocket to stream mic data.
   * Returns the sessionId on success, or throws on failure.
   */
  async startAudioStream(callerName?: string, options?: { channels?: Record<string, { label: string; source: string }> }): Promise<{ sessionId: string; callId: string }> {
    const config = await this.getConfig();
    if (!config) throw new Error('Gateway not configured — set gateway_url and api_key in the Enterprise Gateway integration');

    // Create session via REST API
    const baseUrl = config.url.replace(/\/+$/, '');
    const sessionUrl = `${ baseUrl }/api/desktop/sessions`;
    console.log(`[GatewayListener] Creating audio session at ${ sessionUrl }`);
    const response = await this.gatewayFetch(sessionUrl, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:  `Bearer ${ config.apiKey }`,
      },
      body: JSON.stringify({
        callerName: callerName || 'Sulla Desktop',
        ...((options?.channels) && { channels: options.channels }),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gateway session creation failed (${ response.status }): ${ body }`);
    }

    const result = await response.json() as { sessionId: string; callId: string };
    this.activeSessionId = result.sessionId;
    this.activeCallId = result.callId;
    this.audioIntentionalClose = false;
    this.audioReconnectAttempts = 0;
    this.audioReconnecting = false;
    this.audioChunkCount = 0;

    await this.connectAudioWs(config);

    // Connect the per-session listener to receive transcript events
    this.connectSessionListener(config);

    return result;
  }

  /**
   * Open (or re-open) the audio WebSocket for the current active session.
   * Separated from startAudioStream so reconnection can reuse it.
   */
  private async connectAudioWs(config: { url: string; apiKey: string }): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;

    const baseUrl = config.url.replace(/\/+$/, '');
    const wsUrl = this.httpToWs(baseUrl);
    const audioUrl = `${ wsUrl }/ws/audio/${ sessionId }`;
    const wsOptions = this.getWsOptions(config);

    this.audioWs = new WebSocket(audioUrl, wsOptions);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Audio WebSocket connection timeout')), 10_000);

      this.audioWs!.on('open', () => {
        clearTimeout(timeout);
        this.audioReconnecting = false;
        this.audioReconnectAttempts = 0;
        console.log(`[GatewayListener] Audio stream connected for session ${ sessionId }`);
        resolve();
      });

      this.audioWs!.on('error', (err: Error) => {
        clearTimeout(timeout);
        console.error(`[GatewayListener] Audio stream error: ${ err.message }`);
        reject(err);
      });
    });

    // Persistent error handler — prevents uncaught EventEmitter error crash.
    // The connection-phase error handler above only covers the initial handshake;
    // this one covers errors after the socket is open (ECONNRESET, etc.).
    this.audioWs.on('error', (err: Error) => {
      console.error(`[GatewayListener] Audio stream error (post-open): ${ err.message }`);
      this.lastError = `Audio error: ${ err.message }`;
      // 'close' event will fire after this, triggering reconnect
    });

    this.audioWs.on('message', (raw: Buffer | string) => {
      const msg = typeof raw === 'string' ? raw : raw.toString('utf8');
      console.log(`[GatewayListener] Audio WS message: ${ msg.slice(0, 500) }`);
    });

    this.audioWs.on('close', (code: number) => {
      console.log(`[GatewayListener] Audio stream closed for session ${ this.activeSessionId } (code ${ code })`);
      this.audioWs = null;

      // Reconnect if the close was unexpected and we still have an active session
      if (!this.audioIntentionalClose && this.activeSessionId) {
        this.scheduleAudioReconnect();
      }
    });
  }

  /**
   * Open a per-session listener WebSocket (`/ws/listener/{sessionId}`) to receive
   * transcript events for the active audio session. The lobby (`/ws/listener`)
   * only receives session lifecycle events; transcripts are delivered on the
   * session-specific channel.
   */
  private connectSessionListener(config: { url: string; apiKey: string }): void {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;

    // Close any existing session listener
    this.closeSessionListener();

    const baseUrl = config.url.replace(/\/+$/, '');
    const wsUrl = this.httpToWs(baseUrl);
    const listenerUrl = `${ wsUrl }/ws/listener/${ sessionId }?apiKey=${ encodeURIComponent(config.apiKey) }`;
    const wsOptions = this.getWsOptions(config);

    console.log(`[GatewayListener] Connecting session listener for ${ sessionId }`);
    this.sessionListenerWs = new WebSocket(listenerUrl, wsOptions);

    this.sessionListenerWs.on('open', () => {
      console.log(`[GatewayListener] Session listener connected for ${ sessionId }`);
      // Opt into reliable delivery on the session channel too
      if (this.sessionListenerWs?.readyState === WebSocket.OPEN) {
        this.sessionListenerWs.send(JSON.stringify({ event_type: 'capabilities', reliable_delivery: true }));
      }
    });

    this.sessionListenerWs.on('message', (data: Buffer) => {
      const raw = data.toString();
      try {
        const event = JSON.parse(raw) as GatewayEvent;

        // ACK reliable delivery messages
        if (event._msg_id && this.sessionListenerWs?.readyState === WebSocket.OPEN) {
          this.sessionListenerWs.send(JSON.stringify({ event_type: 'ack', _msg_id: event._msg_id }));
        }

        // Skip protocol-only messages
        if (event.event_type === 'health_ping' || event.event_type === 'welcome' || event.event_type === 'capabilities_ack') {
          return;
        }

        console.log(`[GatewayListener] Session event: ${ event.event_type } for ${ sessionId } (listeners: ${ this.listeners.size })`);
        this.emit(event);
      } catch {
        console.warn(`[GatewayListener] Session listener non-JSON message: ${ raw.slice(0, 200) }`);
      }
    });

    this.sessionListenerWs.on('error', (err: Error) => {
      console.error(`[GatewayListener] Session listener error: ${ err.message }`);
      // Null the ref so closeSessionListener() doesn't try to terminate an errored socket.
      // The 'close' event should fire after this and trigger reconnect, but if it doesn't
      // (some ws versions), we schedule reconnect defensively here too.
      this.sessionListenerWs = null;
    });

    this.sessionListenerWs.on('close', (code: number) => {
      console.log(`[GatewayListener] Session listener closed (code ${ code })`);
      this.sessionListenerWs = null;

      // Reconnect if the session is still active and we didn't close intentionally
      if (!this.audioIntentionalClose && this.activeSessionId === sessionId) {
        console.log('[GatewayListener] Reconnecting session listener in 2s...');
        setTimeout(() => {
          if (this.activeSessionId === sessionId && !this.audioIntentionalClose) {
            this.getConfig().then((cfg) => {
              if (cfg) this.connectSessionListener(cfg);
              else console.warn('[GatewayListener] Session listener reconnect skipped — no config');
            }).catch((err) => {
              console.error(`[GatewayListener] Session listener reconnect config error: ${ err.message || err }`);
            });
          }
        }, 2000);
      }
    });
  }

  private closeSessionListener(): void {
    if (this.sessionListenerWs) {
      try { this.sessionListenerWs.terminate() } catch (err) { console.warn('[GatewayListener] Session listener terminate error:', err) }
      this.sessionListenerWs = null;
    }
  }

  private scheduleAudioReconnect(): void {
    if (this.audioReconnectAttempts >= AUDIO_MAX_RECONNECT_ATTEMPTS) {
      const msg = `Audio reconnect failed after ${ AUDIO_MAX_RECONNECT_ATTEMPTS } attempts`;
      console.error(`[GatewayListener] ${ msg }`);
      this.lastError = msg;
      this.audioReconnecting = false;
      return;
    }

    this.audioReconnecting = true;
    this.audioReconnectAttempts++;
    const delay = AUDIO_RECONNECT_DELAY_MS * this.audioReconnectAttempts; // linear backoff

    console.log(`[GatewayListener] Audio reconnect attempt ${ this.audioReconnectAttempts }/${ AUDIO_MAX_RECONNECT_ATTEMPTS } in ${ delay }ms`);

    this.audioReconnectTimer = setTimeout(async() => {
      this.audioReconnectTimer = null;
      try {
        const config = await this.getConfig();
        if (!config || !this.activeSessionId) return;
        await this.connectAudioWs(config);
      } catch (err: any) {
        console.error(`[GatewayListener] Audio reconnect failed: ${ err.message }`);
        // The close handler on the new WS will trigger another scheduleAudioReconnect
        // only if connectAudioWs threw before the close handler was attached.
        // In that case, try again:
        if (this.activeSessionId && !this.audioIntentionalClose) {
          this.scheduleAudioReconnect();
        }
      }
    }, delay);
  }

  /**
   * Send a chunk of raw audio data to the gateway.
   * @param data - Raw audio bytes
   * @param channel - Virtual channel ID (0 = default/mono). When > 0, frames are
   *                  prefixed with [0x01][channel] so the gateway can route them
   *                  to the correct per-channel STT pipeline.
   */
  private audioChunkCount = 0;

  sendAudio(data: Buffer | ArrayBuffer, channel = 0): void {
    if (!this.audioWs || this.audioWs.readyState !== WebSocket.OPEN) {
      if (this.audioChunkCount === 0) {
        console.warn(`[GatewayListener] sendAudio called but WebSocket not open (ws=${ !!this.audioWs }, readyState=${ this.audioWs?.readyState })`);
      }

      return;
    }

    // Skip if the outbound buffer is backed up — prevents memory runaway
    if (this.audioWs.bufferedAmount > AUDIO_BACKPRESSURE_THRESHOLD) {
      console.warn(`[GatewayListener] Audio backpressure — skipping chunk (buffered: ${ this.audioWs.bufferedAmount })`);

      return;
    }

    const audioBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    // Tag with virtual channel header when channel > 0
    // Wire format: [0x01 magic][channel uint8][audio bytes...]
    // Channel 0 sends raw (no header) for backward compatibility with
    // gateways that don't understand the channel protocol yet.
    let buf: Buffer;

    if (channel > 0) {
      buf = Buffer.allocUnsafe(2 + audioBuf.length);
      buf[0] = 0x01; // magic byte
      buf[1] = channel;
      audioBuf.copy(buf, 2);
    } else {
      buf = audioBuf;
    }

    this.audioChunkCount++;
    if (this.audioChunkCount <= 3 || this.audioChunkCount % 100 === 0) {
      console.log(`[GatewayListener] Sending audio chunk #${ this.audioChunkCount } ch=${ channel } (${ buf.length } bytes)`);
    }
    try {
      this.audioWs.send(buf);
    } catch (err: any) {
      console.error(`[GatewayListener] Audio send failed (chunk #${ this.audioChunkCount }): ${ err.message }`);
    }
  }

  /** Close the audio stream and end the gateway session. */
  async stopAudioStream(): Promise<void> {
    const sessionId = this.activeSessionId;

    // Prevent reconnection attempts
    this.audioIntentionalClose = true;
    this.audioReconnecting = false;
    if (this.audioReconnectTimer) {
      clearTimeout(this.audioReconnectTimer);
      this.audioReconnectTimer = null;
    }

    // Close session listener and audio WebSocket
    this.closeSessionListener();
    if (this.audioWs) {
      this.audioWs.close(1000, 'Recording stopped');
      this.audioWs = null;
    }

    // End session via REST API
    if (sessionId) {
      this.activeSessionId = null;
      this.activeCallId = null;

      try {
        const config = await this.getConfig();
        if (config) {
          const baseUrl = config.url.replace(/\/+$/, '');
          const resp = await this.gatewayFetch(`${ baseUrl }/api/desktop/sessions/${ sessionId }`, {
            method:  'DELETE',
            headers: { Authorization: `Bearer ${ config.apiKey }` },
          });
          if (!resp.ok) {
            console.warn(`[GatewayListener] Session DELETE failed (${ resp.status }) for ${ sessionId }`);
          }
        }
      } catch (err: any) {
        console.error(`[GatewayListener] Session DELETE error for ${ sessionId }: ${ err.message }`);
      }

      console.log(`[GatewayListener] Session ended: ${ sessionId }`);
    }
  }

  // ─── Lobby connection ───────────────────────────────────────

  private async connectLobby(): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      this.lastError = 'Gateway not configured';
      return;
    }

    const wsUrl = this.httpToWs(config.url.replace(/\/+$/, ''));
    const params = new URLSearchParams({
      appName:    'SullaDesktop',
      appVersion: process.env.APP_VERSION || '1.0.0',
      hostname:   os.hostname(),
    });

    const url = `${ wsUrl }/ws/listener?${ params }`;
    const wsOptions = {
      ...this.getWsOptions(config),
      headers: { Authorization: `Bearer ${ config.apiKey }` },
    };

    console.log('[GatewayListener] Connecting to lobby...');
    this.lobbyWs = new WebSocket(url, wsOptions);

    this.lobbyWs.on('open', () => {
      console.log('[GatewayListener] Lobby connected');
      this.lobbyReconnectDelay = RECONNECT_DELAY_MS;
      this.lobbyReconnectAttempts = 0;
      this.lastError = null;
      this.resetPingTimer();

      // Opt into reliable delivery — gateway will track messages and retry on no ACK
      this.lobbySend({ event_type: 'capabilities', reliable_delivery: true });
    });

    this.lobbyWs.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString()) as GatewayEvent;

        // Reset ping timer on ANY message — not just health_ping.
        // Prevents false-positive dead-connection kills when the gateway
        // is actively sending session events but a ping is slightly delayed.
        this.resetPingTimer();

        // ACK messages that carry a _msg_id (reliable delivery protocol)
        if (event._msg_id) {
          this.lobbySend({ event_type: 'ack', _msg_id: event._msg_id });
        }

        // Protocol messages — don't propagate to app listeners
        if (event.event_type === 'health_ping' || event.event_type === 'connected' || event.event_type === 'capabilities_ack') {
          return;
        }

        // Transcript events are delivered via the per-session listener WS, not the lobby.
        // Skip them here to prevent duplicate messages in the renderer.
        if (event.event_type === 'transcript_turn' || event.event_type === 'transcript_partial') {
          console.log(`[GatewayListener] Lobby: ignoring ${ event.event_type } (delivered via session listener)`);
          return;
        }

        console.log(`[GatewayListener] Lobby event: ${ event.event_type } (listeners: ${ this.listeners.size })`);
        this.emit(event);
      } catch (err) {
        console.warn(`[GatewayListener] Lobby non-JSON message: ${ data.toString().slice(0, 200) }`);
      }
    });

    this.lobbyWs.on('close', (code: number, reason: Buffer) => {
      console.log(`[GatewayListener] Lobby closed: ${ code } ${ reason?.toString() }`);
      this.lobbyWs = null;
      this.clearPingTimer();

      if (!this.lobbyIntentional) {
        this.scheduleLobbyReconnect();
      }
    });

    this.lobbyWs.on('error', (err: Error) => {
      this.lastError = err.message;
      console.error('[GatewayListener] Lobby error:', err.message);
      // 'close' event will fire after this, triggering reconnect
    });
  }

  private scheduleLobbyReconnect(): void {
    this.clearLobbyReconnect();
    this.lobbyReconnectAttempts++;

    if (this.lobbyReconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      const msg = `Lobby reconnect gave up after ${ MAX_RECONNECT_ATTEMPTS } attempts`;
      console.error(`[GatewayListener] ${ msg }`);
      this.lastError = msg;
      return;
    }

    console.log(`[GatewayListener] Reconnecting lobby in ${ this.lobbyReconnectDelay }ms (attempt ${ this.lobbyReconnectAttempts }/${ MAX_RECONNECT_ATTEMPTS })...`);
    this.lobbyReconnectTimer = setTimeout(async() => {
      this.lobbyReconnectTimer = null;
      try {
        await this.connectLobby();
      } catch (err: any) {
        this.lastError = err.message;
        this.lobbyReconnectDelay = Math.min(this.lobbyReconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        this.scheduleLobbyReconnect();
      }
    }, this.lobbyReconnectDelay);
    this.lobbyReconnectDelay = Math.min(this.lobbyReconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private clearLobbyReconnect(): void {
    if (this.lobbyReconnectTimer) {
      clearTimeout(this.lobbyReconnectTimer);
      this.lobbyReconnectTimer = null;
    }
  }

  private resetPingTimer(): void {
    this.clearPingTimer();
    this.lobbyPingTimer = setTimeout(() => {
      console.warn('[GatewayListener] No ping received, assuming connection dead');
      if (this.lobbyWs) {
        this.lobbyWs.terminate();
      }
    }, PING_TIMEOUT_MS);
  }

  private clearPingTimer(): void {
    if (this.lobbyPingTimer) {
      clearTimeout(this.lobbyPingTimer);
      this.lobbyPingTimer = null;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  /** Send a JSON message on the lobby WebSocket. */
  private lobbySend(msg: Record<string, unknown>): void {
    if (this.lobbyWs && this.lobbyWs.readyState === WebSocket.OPEN) {
      try {
        this.lobbyWs.send(JSON.stringify(msg));
      } catch (err: any) {
        console.error(`[GatewayListener] Lobby send failed: ${ err.message }`);
      }
    }
  }

  private emit(event: GatewayEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error('[GatewayListener] Event listener error:', err);
      }
    }
  }

  private async getConfig(): Promise<{ url: string; apiKey: string } | null> {
    const integrationService = getIntegrationService();
    const [urlValue, keyValue] = await Promise.all([
      integrationService.getIntegrationValue('enterprise_gateway', 'gateway_url'),
      integrationService.getIntegrationValue('enterprise_gateway', 'api_key'),
    ]);

    const url = urlValue?.value?.trim();
    const apiKey = keyValue?.value?.trim();
    if (url && apiKey) return { url, apiKey };
    return null;
  }

  private httpToWs(url: string): string {
    return url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  }

  private getWsOptions(config: { url: string }): Record<string, unknown> {
    // Skip SSL verification for local dev (self-signed certs)
    if (this.isLocalUrl(config.url)) {
      return { rejectUnauthorized: false };
    }
    return {};
  }

  /**
   * Fetch wrapper that skips TLS verification for local/dev URLs
   * (self-signed certs on localhost). Matches the same TLS policy as WebSocket.
   */
  private async gatewayFetch(url: string, init: RequestInit): Promise<Response> {
    if (url.startsWith('https:') && this.isLocalUrl(url)) {
      const { Agent } = require('undici');
      const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

      return fetch(url, { ...init, dispatcher } as any);
    }

    return fetch(url, init);
  }

  private isLocalUrl(url: string): boolean {
    try {
      const { hostname } = new URL(url);

      return hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '127.0.0.1' ||
        hostname.startsWith('127.') ||
        hostname === '0.0.0.0' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        hostname.endsWith('.local');
    } catch {
      return false;
    }
  }
}
