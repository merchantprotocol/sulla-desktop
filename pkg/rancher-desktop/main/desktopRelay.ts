/**
 * Desktop relay client.
 *
 * Connects to the Cloudflare Worker `/relay/:room` WebSocket as role=desktop
 * and processes chat requests from a paired mobile device.
 *
 * Room name = the mobile user's user_id (stored locally as `pairedMobileUserId`).
 * When the room is set, we stay connected. When chat comes in, we feed it to
 * ClaudeCodeService and ship the response back.
 *
 * Phase 1: manual pairing — user copies their mobile user_id into Language
 * Model Settings. Phase 2 will replace this with QR pairing.
 */

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getWebSocketClientService, type WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { stripProtocolTags } from '@pkg/agent/utils/stripProtocolTags';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

const RELAY_URL = 'wss://sulla-workers.jonathon-44b.workers.dev';
// Local WebSocket channel that BackendGraphWebSocketService watches for
// mobile-originated chats. Must match the constant in that file.
const MOBILE_RELAY_CHANNEL = 'mobile-relay';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 30_000;
// Heartbeat + watchdog tuned for Cloudflare Workers: the DO auto-responds to
// "ping" with "pong" via setWebSocketAutoResponse without waking from
// hibernation. A 20s ping interval + 45s silence watchdog keeps the pipe
// warm through NAT/proxy idle timeouts and surfaces silently-dead sockets
// (where TCP never FINs) well before Cloudflare's ~10min hibernation cutoff.
const PING_INTERVAL_MS = 20_000;
const STALE_SOCKET_MS  = 45_000;
// If a freshly-opened socket doesn't fire `open` in this window, we assume
// it's stuck and tear it down. Prevents a wedged connect from pinning the
// client in "connecting" forever.
const CONNECT_TIMEOUT_MS = 15_000;

type Role = 'desktop' | 'mobile';

interface IncomingMessage {
  type:            string;
  messages?:       Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  conversationId?: string;
  /**
   * When the mobile picks a specific desktop to route to (AI Assistant →
   * Which Desktop), the chat payload carries that device's id. The relay
   * broadcasts to every desktop in the room; desktops whose id doesn't
   * match silently drop the message.
   */
  targetDeviceId?: string;
  role?:           Role;
  reason?:         string;
}

interface Status {
  pairedUserId: string;
  connected:    boolean;
  lastError?:   string;
}

class DesktopRelayClient {
  private ws: WebSocket | null = null;
  private currentRoom: string | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private connected = false;
  private lastError = '';
  private statusListeners: Array<(s: Status) => void> = [];
  // Stop requests from mobile go out to the agent via stop_run on the
  // mobile-relay channel (see handleMessage). No local in-process
  // AbortController state is needed anymore — the agent owns aborts now.
  // Subscription guard so we only hook the mobile-relay channel once.
  private mobileChannelBridged = false;

  // ── Liveness tracking ──────────────────────────────────────
  // The DO auto-responds to application-level "ping" frames with "pong",
  // without waking from hibernation. We send a ping on a timer and watch
  // for any inbound message (pong, chat, anything) to prove the pipe is
  // still alive. If the socket goes silent for STALE_SOCKET_MS we force a
  // reconnect — the `close` event alone is unreliable when intermediaries
  // drop the connection without sending a TCP FIN.
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  // Guards against a stuck `new WebSocket()` that never resolves to `open`.
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  async start(): Promise<void> {
    const paired = (await SullaSettingsModel.get('pairedMobileUserId', '')) ?? '';
    if (paired) {
      this.connect(paired);
    } else {
      console.log('[DesktopRelay] No paired mobile user — waiting for pairing');
    }
  }

  /** Called by IPC when the user saves a new pairing code. */
  async setPairedUserId(userId: string): Promise<void> {
    const trimmed = userId.trim();
    await SullaSettingsModel.set('pairedMobileUserId', trimmed, 'string');
    this.disconnect();
    if (trimmed) this.connect(trimmed);
    else this.broadcastStatus();
  }

  getStatus(): Status {
    return {
      pairedUserId: this.currentRoom ?? '',
      connected:    this.connected,
      lastError:    this.lastError || undefined,
    };
  }

  onStatusChange(listener: (s: Status) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== listener);
    };
  }

  // ── Internal ────────────────────────────────────────────

  private connect(room: string) {
    this.intentionallyClosed = false;
    this.currentRoom = room;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.openSocket().catch((err) => {
      console.warn('[DesktopRelay] openSocket failed:', err);
    });
  }

  private disconnect() {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownLiveness();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.currentRoom = null;
    this.connected = false;
    this.broadcastStatus();
  }

  /** Stop all heartbeat/watchdog/connect timers. Idempotent. */
  private teardownLiveness() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    if (this.connectTimeoutTimer) { clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }
  }

  /**
   * Tear down the current socket and schedule a reconnect. Called on error
   * events, stale-socket watchdog trips, and connect-timeout expiry — every
   * failure path funnels here so we can't leak sockets or timers.
   */
  private forceReconnect(reason: string) {
    if (this.intentionallyClosed) return;
    console.warn(`[DesktopRelay] Forcing reconnect — ${ reason }`);
    this.teardownLiveness();
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.connected = false;
    this.broadcastStatus();
    this.scheduleReconnect();
  }

  private async openSocket() {
    if (!this.currentRoom) return;
    const room = this.currentRoom;

    const token = await getCurrentAccessToken();
    if (!token) {
      this.lastError = 'Not signed in — relay cannot authenticate';
      console.warn('[DesktopRelay] No access token — skipping connect. Sign in first.');
      this.broadcastStatus();
      // Retry later; a successful sign-in will re-trigger via setPairedUserId.
      this.scheduleReconnect();
      return;
    }

    const url = `${ RELAY_URL }/relay/${ encodeURIComponent(room) }?role=desktop&token=${ encodeURIComponent(token) }`;

    // Log without the token to avoid leaking into local log files.
    console.log(`[DesktopRelay] Connecting: ${ RELAY_URL }/relay/${ encodeURIComponent(room) }?role=desktop`);

    const ws = new WebSocket(url);
    this.ws = ws;

    // If the socket doesn't open in time, give up and reconnect. Without
    // this a stuck TCP handshake can park us in "connecting" indefinitely.
    this.connectTimeoutTimer = setTimeout(() => {
      this.connectTimeoutTimer = null;
      if (this.ws === ws && !this.connected) {
        this.forceReconnect(`connect timeout after ${ CONNECT_TIMEOUT_MS }ms`);
      }
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      if (this.connectTimeoutTimer) { clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }
      this.connected = true;
      this.lastError = '';
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.lastInboundAt = Date.now();
      console.log(`[DesktopRelay] Connected — room=${ room }`);
      this.broadcastStatus();

      // Start heartbeat: send a ping every PING_INTERVAL_MS. The DO
      // auto-replies without waking, so this is cheap on the server.
      this.pingTimer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* socket in bad state; watchdog will handle */ }
      }, PING_INTERVAL_MS);

      // Watchdog: any silent period >STALE_SOCKET_MS means the pipe is
      // dead even if the browser hasn't fired `close` yet. Force-reconnect.
      this.watchdogTimer = setInterval(() => {
        const silentMs = Date.now() - this.lastInboundAt;
        if (silentMs > STALE_SOCKET_MS) {
          this.forceReconnect(`no inbound traffic for ${ silentMs }ms`);
        }
      }, Math.floor(STALE_SOCKET_MS / 3));
    });

    ws.addEventListener('message', (event) => {
      this.lastInboundAt = Date.now();
      this.handleMessage(event.data as string);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this.teardownLiveness();
      console.log('[DesktopRelay] Socket closed');
      this.broadcastStatus();
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });

    ws.addEventListener('error', (e: any) => {
      this.lastError = e?.message || 'WebSocket error';
      console.warn('[DesktopRelay] Error:', this.lastError);
      this.broadcastStatus();
      // Some runtimes don't fire `close` after `error`, especially on
      // half-open sockets. Force the reconnect path so we never sit idle
      // waiting for a `close` that may never arrive.
      this.forceReconnect(`socket error: ${ this.lastError }`);
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.currentRoom) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    console.log(`[DesktopRelay] Reconnecting in ${ delay }ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch((err) => {
        console.warn('[DesktopRelay] openSocket failed:', err);
      });
    }, delay);
  }

  private async handleMessage(raw: string) {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn('[DesktopRelay] Non-JSON message received');
      return;
    }

    if (msg.type === 'connected') {
      // ACK from the DO — already handled via 'open'
      return;
    }

    if (msg.type === 'pong') {
      // Keepalive reply from the DO's auto-response. Watchdog already
      // reset lastInboundAt on the message event above; nothing else to do.
      return;
    }

    if (msg.type === 'error') {
      console.warn(`[DesktopRelay] Relay error: ${ msg.reason }`);
      return;
    }

    if (msg.type === 'chat') {
      // When mobile targets a specific desktop, only the matching device
      // should handle the request. This is enforced client-side because the
      // relay DO broadcasts to every desktop peer in the room.
      if (msg.targetDeviceId) {
        try {
          const myId = await getDesktopDeviceId();
          if (msg.targetDeviceId !== myId) {
            console.log(`[DesktopRelay] Ignoring chat — addressed to ${ msg.targetDeviceId }, I am ${ myId }`);
            return;
          }
        } catch (err) {
          console.warn('[DesktopRelay] device_id lookup failed; handling chat anyway:', err);
        }
      }
      await this.handleChatRequest(msg);
      return;
    }

    if (msg.type === 'cancel') {
      // Mobile hit the stop button. Publish stop_run on the mobile-relay
      // channel — BackendGraphWebSocketService.handleChannelMessage handles
      // stop_run by aborting the active agent run (which propagates through
      // ClaudeCodeService → limactl kill + in-VM claude pkill).
      const conversationId = msg.conversationId ?? this.currentRoom ?? '__default__';
      console.log(`[DesktopRelay] Cancel received for conversationId=${ conversationId }`);
      const wsService = getWebSocketClientService();
      wsService.send(MOBILE_RELAY_CHANNEL, {
        type:      'stop_run',
        data:      { threadId: conversationId },
        timestamp: Date.now(),
      });
      // Ack back to mobile so it knows the run ended without waiting for
      // `done` (which may never arrive after an abort). The mobile session
      // socket stays open — this is not a close signal.
      this.send({ type: 'stopped' });
      return;
    }

    if (msg.type === 'inject') {
      // Mobile sent a mid-run message. Inject it into the running graph state
      // without aborting — the agent picks it up at the next loop boundary.
      const lastUser = (msg.messages ?? []).slice().reverse().find((m: any) => m.role === 'user');
      const content = (lastUser?.content ?? '').trim();
      if (!content) return;
      const conversationId = msg.conversationId ?? this.currentRoom ?? undefined;
      console.log(`[DesktopRelay] Inject received for conversationId=${ conversationId ?? '(none)' }`);
      const wsService = getWebSocketClientService();
      wsService.send(MOBILE_RELAY_CHANNEL, {
        type:      'inject_message',
        data:      {
          content,
          threadId: conversationId,
          metadata: { source: 'mobile-relay', inputSource: 'keyboard', conversationId },
        },
        timestamp: Date.now(),
      });
      return;
    }

    console.log(`[DesktopRelay] Unknown message type: ${ msg.type }`);
  }

  /**
   * Bridge a mobile chat request onto the local agent channel.
   *
   * Previously this method called ClaudeCodeService.chatStream directly,
   * bypassing the entire AgentNode/BaseNode pipeline — which meant the
   * `<AGENT_DONE>` / `<AGENT_CONTINUE>` protocol wrappers, tool execution,
   * memory recall, and subconscious middleware all got skipped. Mobile saw
   * raw XML-tagged responses and the desktop's full agent capabilities
   * never applied to mobile-originated chats.
   *
   * The relay is now a pure bridge: it translates the mobile `chat` frame
   * into a `user_message` on the local `mobile-relay` WebSocket channel
   * and lets BackendGraphWebSocketService route it through the normal
   * agent loop (same AgentNode, same strip, same tools). Responses
   * emitted by the agent arrive as `assistant_message`/streaming frames
   * on the same channel, which our subscription picks up and forwards
   * back up to Cloudflare as `chunk`/`done` frames mobile already
   * understands.
   */
  private async handleChatRequest(msg: IncomingMessage) {
    const messages = msg.messages ?? [];
    const conversationId = msg.conversationId ?? this.currentRoom ?? undefined;
    console.log(`[DesktopRelay] Chat request — ${ messages.length } messages, conversationId=${ conversationId ?? '(none)' }`);

    // Extract the user prompt from the incoming frame. The agent maintains
    // its own conversation state keyed by threadId; we only need the fresh
    // user turn each request. If the mobile client sends a multi-message
    // payload, pick the last user turn — older messages are already in the
    // thread on the desktop side.
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const content = (lastUser?.content ?? '').trim();
    if (!content) {
      console.warn('[DesktopRelay] Chat request had no user content; ignoring');
      this.send({ type: 'error', reason: 'empty_user_message' });
      return;
    }

    this.ensureMobileChannelBridge();

    const wsService = getWebSocketClientService();
    wsService.send(MOBILE_RELAY_CHANNEL, {
      type: 'user_message',
      data: {
        content,
        threadId: conversationId,
        metadata: {
          source:         'mobile-relay',
          inputSource:    'keyboard',
          conversationId,
        },
      },
      timestamp: Date.now(),
    });

    // ACK immediately so mobile knows the desktop received the message and the
    // agent loop is starting. Without this, mobile sits in silence until the
    // first streaming chunk arrives — which can look like a timeout.
    this.send({ type: 'ack' });
  }

  /**
   * Install the one-time subscription to the mobile-relay channel. Messages
   * the agent emits during execution (streaming tokens, activity, final
   * assistant_message, graph completion) arrive here; we translate each
   * into the frame shape mobile already understands and forward it up to
   * Cloudflare.
   *
   * Idempotent — runs once on first use. The subscription lives for the
   * lifetime of the relay client; no need to tear down on reconnect since
   * it's local, not over the wire to Cloudflare.
   *
   * Protocol translation notes:
   *
   *   - `assistant_message kind=streaming` carries the AGENT's accumulated
   *     buffer each tick, but mobile expects *incremental deltas* (it
   *     concatenates them into its own streamBuffer). We compute the delta
   *     by comparing the new buffer to what we last sent.
   *
   *   - `assistant_message kind=thinking` is activity indication (tool use,
   *     reasoning) — forward as `activity`.
   *
   *   - `assistant_message kind=progress` (the default) is the agent's
   *     authoritative text for one iteration of the loop. It duplicates
   *     what streaming already sent, so we record it as the "final text
   *     so far" but don't forward it as a chunk.
   *
   *   - `transfer_data content='graph_execution_complete'` is the real
   *     end-of-run signal. THIS is when we emit `done` to mobile so it
   *     closes the socket and resolves its pending promise. Emitting
   *     `done` any earlier (e.g. on the first progress message) closes
   *     the mobile socket mid-turn and everything after is lost.
   */
  private ensureMobileChannelBridge() {
    if (this.mobileChannelBridged) return;
    this.mobileChannelBridged = true;

    const wsService = getWebSocketClientService();
    wsService.connect(MOBILE_RELAY_CHANNEL);

    // Per-thread state: the last-sent streaming buffer (for delta math)
    // and the latest known "final text" (for when we emit done).
    // Keyed by thread_id so two simultaneous mobile conversations don't
    // corrupt each other's delta computation.
    const streamedByThread = new Map<string, string>();
    const finalTextByThread = new Map<string, string>();
    let lastActivity = '';

    wsService.onMessage(MOBILE_RELAY_CHANNEL, (msg: WebSocketMessage) => {
      if (msg.type === 'assistant_message') {
        const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
        const kind = typeof data.kind === 'string' ? data.kind : '';
        const threadId = typeof data.thread_id === 'string' ? data.thread_id : '';
        const raw = typeof data.content === 'string' ? data.content : '';
        if (!raw) return;
        // Defense-in-depth: agent already strips wrappers, but a final strip
        // here guarantees nothing slips through if a new message kind is
        // added that doesn't pass through the normal strip path.
        const stripped = stripProtocolTags(raw);
        if (!stripped) return;

        if (kind === 'thinking') {
          // Tool-use / reasoning indicator. De-dup consecutive duplicates.
          if (stripped === lastActivity) return;
          lastActivity = stripped;
          this.send({ type: 'activity', message: stripped });
          return;
        }

        if (kind === 'streaming') {
          // Agent re-sends the accumulated buffer each tick. Mobile
          // replaces its local streamBuffer on each chunk (see the
          // `streamBuffer = delta` line in sulla-mobile/desktop-relay.ts),
          // so we ship the full buffer in `delta` rather than computing
          // incremental slices. Mobile gets the authoritative snapshot
          // every tick and can render it without concatenation drift.
          const prev = streamedByThread.get(threadId) ?? '';
          if (stripped === prev) return; // no-op tick
          streamedByThread.set(threadId, stripped);
          this.send({ type: 'chunk', delta: stripped });
          return;
        }

        if (kind === 'progress' || kind === '') {
          // Agent's authoritative final text for this iteration. Send it
          // immediately as its own committed message so mobile can append it
          // to the thread and speak it without waiting for the full graph to
          // finish. Reset the streaming buffer so the next iteration starts
          // a fresh streaming bubble rather than accumulating onto this one.
          streamedByThread.delete(threadId);
          this.send({ type: 'message', content: stripped });
          return;
        }

        // Any other kind (e.g. thinking_complete) — intentionally ignored.
        return;
      }

      if (msg.type === 'transfer_data') {
        // Graph.execute emits { role: 'system', content: 'graph_execution_complete' }
        // on the channel when the agent run is fully done. If progress messages
        // arrived, they were already forwarded as `message` events and the
        // streamed buffer was cleared — so finalText will be empty and `done`
        // is just a completion signal. If no progress message arrived (a
        // streaming-only run), the streamed buffer still holds the text and
        // we ship it here as the sole content for backward compatibility.
        const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
        const content = typeof data.content === 'string' ? data.content : '';
        if (content !== 'graph_execution_complete') return;
        const threadId = typeof data.thread_id === 'string' ? data.thread_id : '';
        const finalText = finalTextByThread.get(threadId) ?? streamedByThread.get(threadId) ?? '';
        streamedByThread.delete(threadId);
        finalTextByThread.delete(threadId);
        lastActivity = '';
        this.send({ type: 'done', content: finalText });
        return;
      }

      if (msg.type === 'thread_created') {
        // Agent created a new threadId for this conversation. Mobile uses
        // its own conversationId scheme; we don't need to plumb this back.
        return;
      }
    });
  }

  private send(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[DesktopRelay] Cannot send — socket not open');
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.warn('[DesktopRelay] Send failed:', err);
    }
  }

  private broadcastStatus() {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* ignore */ }
    }
  }
}

let instance: DesktopRelayClient | null = null;

export function getDesktopRelayClient(): DesktopRelayClient {
  if (!instance) instance = new DesktopRelayClient();
  return instance;
}

export function initDesktopRelayEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);
  const client = getDesktopRelayClient();

  ipcMainProxy.handle('desktop-relay:get-status', async() => {
    return client.getStatus();
  });

  ipcMainProxy.handle('desktop-relay:set-paired-user-id', async(_event: unknown, userId: string) => {
    await client.setPairedUserId(userId);
    return client.getStatus();
  });

  // Broadcast status changes to renderer
  client.onStatusChange((status) => {
    try {
      const { BrowserWindow } = require('electron') as typeof import('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.webContents.send('desktop-relay:status-changed', status); } catch { /* ignore */ }
      }
    } catch { /* electron not ready */ }
  });

  // Kick off the connection on load if a pairing already exists
  client.start().catch((err) => {
    console.warn('[DesktopRelay] start() failed:', err);
  });
}
