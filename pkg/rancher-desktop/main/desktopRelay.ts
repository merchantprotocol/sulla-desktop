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
 *
 * ── Authoritative scribe ────────────────────────────────────────────────
 * The desktop is the system of record for relay conversations. Every
 * committed turn — the inbound mobile user message, injected mid-run
 * messages, each committed assistant message, and tool activity — is
 * written to the sync log (local claude_messages/claude_conversations via
 * scribeRelayTurn, then pushed by SullaSyncService with retry) independently
 * of WebSocket delivery. The WS frames are a best-effort real-time push; if
 * the phone is asleep or offline, it recovers the missed turns from cloud
 * claude_messages on its next on-demand history load. Losing the socket
 * must never lose conversation history.
 *
 * Scribing goes through the sync queue rather than POSTing the cloud REST
 * API directly: the queue writes local Postgres first (so desktop history
 * and syncDispatcher dedup work offline) and survives network failures via
 * the 15s retry loop, where a direct fetch would silently drop the turn.
 */

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getWebSocketClientService, type WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { stripProtocolTags } from '@pkg/agent/utils/stripProtocolTags';
import { claudeMessageExists, deriveMessageId, scribeRelayTurn } from '@pkg/main/sync/syncMirror';
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
  /**
   * Row id the mobile client already inserted its user turn under (chat and
   * inject frames). Scribing under the SAME id makes the desktop's copy and
   * the mobile's copy the same row after sync, instead of a duplicate pair.
   */
  userMessageId?:  string;
  role?:           Role;
  reason?:         string;
}

interface Status {
  pairedUserId: string;
  connected:    boolean;
  lastError?:   string;
}

// Exported for tests only — production code must go through getDesktopRelayClient().
export class DesktopRelayClient {
  private ws: WebSocket | null = null;
  private currentRoom: string | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed reconnect cycles — drives log suppression only. */
  private failedAttempts = 0;
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

  // ── Mobile keepalive + send queue ──────────────────────────
  // During long tool-execution phases (e.g. ClaudeCode running) there may
  // be 30–120 s of silence on the relay. Mobile clients typically have a
  // shorter idle timeout that will fire and show a "timeout error" before
  // the agent finishes. Per-conversation keepalive timers send a `keepalive`
  // frame every 15 s so the Cloudflare relay keeps mobile's WS open.
  // Keyed by conversationId (same value used as threadId in the agent).
  private keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>();
  // Critical completion frames (done/stopped/error) that couldn't be sent
  // because the socket was reconnecting. Flushed immediately on `open`.
  private pendingFrames: string[] = [];
  // Conversations with an in-flight agent run. Keepalive only runs while the
  // mobile peer is online; peer_offline pauses it so we don't spam the DO
  // with undeliverable frames during a mobile reconnect.
  private activeConversations = new Set<string>();
  private mobilePeerOnline = true;
  // System-sleep gate. While the machine is suspended we close the socket on
  // purpose and must not schedule reconnects that can't succeed. Set on
  // powerMonitor 'suspend', cleared on 'resume' (see sullaEvents.ts).
  private suspended = false;

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

  /**
   * powerMonitor 'suspend': close the socket proactively so the relay DO
   * drops this peer immediately — mobile sees the desktop go offline right
   * away instead of after the server-side stale timeout. No reconnects are
   * scheduled while suspended.
   */
  handleSuspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (!this.currentRoom) return;
    console.log('[DesktopRelay] System suspending — closing relay socket');
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.teardownLiveness();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    this.broadcastStatus();
  }

  /**
   * powerMonitor 'resume': reconnect immediately with fresh backoff instead
   * of waiting for the stale-socket watchdog to notice (which could take
   * up to STALE_SOCKET_MS plus the accumulated backoff after wake).
   */
  handleResume(): void {
    this.suspended = false;
    if (!this.currentRoom || this.intentionallyClosed) return;
    console.log('[DesktopRelay] System resumed — reconnecting relay socket');
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.failedAttempts = 0;
    this.forceReconnect('system resumed');
  }

  // ── Internal ────────────────────────────────────────────

  private connect(room: string) {
    this.intentionallyClosed = false;
    this.currentRoom = room;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.openSocket().catch((err) => {
      console.warn('[DesktopRelay] openSocket failed:', err);
      // A throw here (e.g. token/DB read during boot) previously left the
      // relay dead until app restart — the reconnect loop only armed itself
      // once a socket existed. Hand the failure to the same backoff machinery.
      this.scheduleReconnect();
    });
  }

  private disconnect() {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownLiveness();
    for (const t of this.keepaliveTimers.values()) clearInterval(t);
    this.keepaliveTimers.clear();
    this.pendingFrames = [];
    this.activeConversations.clear();
    this.mobilePeerOnline = true;
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
    if (this.failedAttempts <= 1 || this.failedAttempts % 20 === 0) {
      console.warn(`[DesktopRelay] Forcing reconnect — ${ reason }${ this.failedAttempts > 1 ? ` (attempt ${ this.failedAttempts }, logging every 20th)` : '' }`);
    }
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
    if (!this.currentRoom || this.suspended) return;
    const room = this.currentRoom;

    const token = await getCurrentAccessToken();
    // The machine may have gone to sleep (or the user unpaired) while we
    // were awaiting the token read — don't open a socket nobody wants.
    if (this.suspended || this.intentionallyClosed) return;
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
    if (this.failedAttempts <= 1 || this.failedAttempts % 20 === 0) {
      console.log(`[DesktopRelay] Connecting: ${ RELAY_URL }/relay/${ encodeURIComponent(room) }?role=desktop`);
    }

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
      if (this.failedAttempts > 1) {
        console.log(`[DesktopRelay] Connected — room=${ room } (recovered after ${ this.failedAttempts } attempts)`);
      } else {
        console.log(`[DesktopRelay] Connected — room=${ room }`);
      }
      this.failedAttempts = 0;
      this.broadcastStatus();

      // Flush frames queued while the socket was reconnecting. Critical for
      // `done`/`stopped`/`error` frames that must reach mobile even if the
      // desktop WS briefly dropped mid-response.
      const pending = this.pendingFrames.splice(0);
      for (const frame of pending) {
        try { ws.send(frame); } catch (err) { console.warn('[DesktopRelay] Failed to flush pending frame:', err); }
      }

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
      if (this.failedAttempts <= 1) {
        console.log('[DesktopRelay] Socket closed');
      }
      this.broadcastStatus();
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });

    ws.addEventListener('error', (e: any) => {
      this.lastError = e?.message || 'WebSocket error';
      if (this.failedAttempts <= 1 || this.failedAttempts % 20 === 0) {
        console.warn('[DesktopRelay] Error:', this.lastError);
      }
      this.broadcastStatus();
      // Some runtimes don't fire `close` after `error`, especially on
      // half-open sockets. Force the reconnect path so we never sit idle
      // waiting for a `close` that may never arrive.
      this.forceReconnect(`socket error: ${ this.lastError }`);
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.currentRoom || this.suspended) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    // During a long outage the 30s-capped backoff retries ~120×/hour and each
    // cycle used to log 3-4 lines (>1,000 pairs observed in one log). Log the
    // first attempt of an outage, then every 20th.
    this.failedAttempts++;
    if (this.failedAttempts === 1 || this.failedAttempts % 20 === 0) {
      console.log(`[DesktopRelay] Reconnecting in ${ delay }ms${ this.failedAttempts > 1 ? ` (attempt ${ this.failedAttempts })` : '' }`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch((err) => {
        console.warn('[DesktopRelay] openSocket failed:', err);
        // Without rescheduling here, a single throw (e.g. the VM's Postgres
        // still waking when getCurrentAccessToken reads the session) killed
        // the reconnect loop permanently — the relay then stayed dead until
        // logout/login. Same fix connect() already has: hand the failure
        // back to the backoff machinery.
        this.scheduleReconnect();
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
      // ACK from the DO — already handled via 'open'. Also means we (re)joined
      // the room; if mobile is already there keepalives can resume.
      this.mobilePeerOnline = true;
      for (const convId of this.activeConversations) {
        this.startKeepalive(convId);
      }
      return;
    }

    if (msg.type === 'pong') {
      // Keepalive reply from the DO's auto-response. Watchdog already
      // reset lastInboundAt on the message event above; nothing else to do.
      return;
    }

    if (msg.type === 'error') {
      if (msg.reason === 'peer_offline') {
        // Mobile dropped out of the room. Keep the agent run alive and queue
        // completion frames; just stop burning keepalive traffic until the
        // peer rejoins (connected frame / next successful send).
        if (this.mobilePeerOnline) {
          console.warn('[DesktopRelay] Mobile peer offline — pausing keepalives until reconnect');
        }
        this.mobilePeerOnline = false;
        for (const t of this.keepaliveTimers.values()) clearInterval(t);
        this.keepaliveTimers.clear();
        return;
      }
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
      const conversationId = msg.conversationId;
      if (!conversationId) {
        console.warn('[DesktopRelay] Rejecting cancel without conversationId');
        this.sendMissingConversationError(msg.userMessageId);
        return;
      }
      console.log(`[DesktopRelay] Cancel received for conversationId=${ conversationId }`);
      const wsService = getWebSocketClientService();
      wsService.send(MOBILE_RELAY_CHANNEL, {
        type:      'stop_run',
        data:      { threadId: conversationId },
        timestamp: Date.now(),
      });
      // Stop the keepalive — run is cancelled.
      const kt = this.keepaliveTimers.get(conversationId);
      if (kt) { clearInterval(kt); this.keepaliveTimers.delete(conversationId); }
      this.activeConversations.delete(conversationId);
      // Ack back to mobile so it knows the run ended without waiting for
      // `done` (which may never arrive after an abort). The mobile session
      // socket stays open — this is not a close signal.
      this.sendChatFrame(conversationId, { type: 'stopped' });
      return;
    }

    if (msg.type === 'inject') {
      // Mobile sent a mid-run message. Inject it into the running graph state
      // without aborting — the agent picks it up at the next loop boundary.
      const lastUser = (msg.messages ?? []).slice().reverse().find((m: any) => m.role === 'user');
      const content = (lastUser?.content ?? '').trim();
      if (!content) return;
      const conversationId = msg.conversationId;
      if (!conversationId) {
        console.warn('[DesktopRelay] Rejecting inject without conversationId');
        this.sendMissingConversationError(msg.userMessageId);
        return;
      }
      console.log(`[DesktopRelay] Inject received for conversationId=${ conversationId ?? '(none)' }`);
      // Injected mid-run turns are part of the conversation record too.
      await this.scribeTurn(conversationId, 'user', content, { id: msg.userMessageId });
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
    const conversationId = msg.conversationId;
    console.log(`[DesktopRelay] Chat request — ${ messages.length } messages, conversationId=${ conversationId ?? '(none)' }`);

    if (!conversationId) {
      console.warn('[DesktopRelay] Rejecting chat without conversationId');
      this.sendMissingConversationError(msg.userMessageId);
      return;
    }

    if (!msg.userMessageId) {
      console.warn(`[DesktopRelay] Rejecting chat for conversationId=${ conversationId } without userMessageId`);
      this.sendChatFrame(conversationId, { type: 'error', reason: 'missing_user_message_id' });
      return;
    }

    // Extract the user prompt from the incoming frame. The agent maintains
    // its own conversation state keyed by threadId; we only need the fresh
    // user turn each request. If the mobile client sends a multi-message
    // payload, pick the last user turn — older messages are already in the
    // thread on the desktop side.
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const content = (lastUser?.content ?? '').trim();
    if (!content) {
      console.warn('[DesktopRelay] Chat request had no user content; ignoring');
      this.sendChatFrame(conversationId, { type: 'error', reason: 'empty_user_message', userMessageId: msg.userMessageId });
      return;
    }

    if (await claudeMessageExists(msg.userMessageId)) {
      console.log(`[DesktopRelay] Duplicate mobile chat ignored — conversationId=${ conversationId }, userMessageId=${ msg.userMessageId }`);
      this.sendChatFrame(conversationId, { type: 'ack', userMessageId: msg.userMessageId, duplicate: true });
      return;
    }

    this.ensureMobileChannelBridge();

    // Scribe the user turn FIRST — the sync log is the authoritative record,
    // and the turn must survive even if the agent dispatch or the socket
    // fails right after this point.
    await this.scribeTurn(conversationId, 'user', content, { id: msg.userMessageId });

    // ACK after the user turn is persisted so mobile can clear its outbox
    // without risking a socket-only acknowledgement.
    this.sendChatFrame(conversationId, { type: 'ack', userMessageId: msg.userMessageId });

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

    // Start a keepalive for this conversation so mobile's idle-timeout doesn't
    // fire during long tool-execution phases (e.g. ClaudeCode running 60–120 s
    // with no streaming). The timer sends a lightweight `keepalive` frame every
    // 15 s and is cleared when the agent emits graph_execution_complete.
    // Skipped while mobile is offline — resumed on peer rejoin.
    this.activeConversations.add(conversationId);
    if (this.mobilePeerOnline) {
      this.startKeepalive(conversationId);
    }
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
    const lastActivityByThread = new Map<string, string>();

    wsService.onMessage(MOBILE_RELAY_CHANNEL, async(msg: WebSocketMessage) => {
      if (msg.type === 'assistant_message') {
        const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
        const kind = typeof data.kind === 'string' ? data.kind : '';
        const threadId = typeof data.thread_id === 'string' ? data.thread_id : '';
        const raw = typeof data.content === 'string' ? data.content : '';
        if (!raw) return;
        if (!threadId) {
          console.warn(`[DesktopRelay] Dropping ${ kind || 'assistant' } frame without thread_id/conversationId`);
          return;
        }
        // Defense-in-depth: agent already strips wrappers, but a final strip
        // here guarantees nothing slips through if a new message kind is
        // added that doesn't pass through the normal strip path.
        const stripped = stripProtocolTags(raw);
        if (!stripped) return;

        if (kind === 'thinking') {
          // Tool-use / reasoning indicator. De-dup consecutive duplicates.
          if (stripped === lastActivityByThread.get(threadId)) return;
          lastActivityByThread.set(threadId, stripped);
          // Scribe tool activity so the history view (and a phone that was
          // asleep) can show what the agent did, not just what it said.
          await this.scribeTurn(threadId, 'tool', stripped);
          this.sendChatFrame(threadId, { type: 'activity', message: stripped });
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
          this.sendChatFrame(threadId, { type: 'chunk', delta: stripped });
          return;
        }

        if (kind === 'progress' || kind === '') {
          // Agent's authoritative final text for this iteration. Send it
          // immediately as its own committed message so mobile can append it
          // to the thread and speak it without waiting for the full graph to
          // finish. Reset the streaming buffer so the next iteration starts
          // a fresh streaming bubble rather than accumulating onto this one.
          finalTextByThread.set(threadId, stripped);
          streamedByThread.delete(threadId);
          // Scribe before the WS send — committed turns must survive even
          // if the phone is asleep and the frame is never delivered. The id
          // is derived here (not awaited from the scribe) so the frame ships
          // without waiting on the DB write; mobile persists under this SAME
          // id, so its copy and ours dedup to one row after sync.
          const ts = new Date().toISOString();
          const id = deriveMessageId(threadId, 'assistant', stripped, ts);
          await this.scribeTurn(threadId, 'assistant', stripped, { id, ts });
          this.sendChatFrame(threadId, { type: 'message', content: stripped, id });
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
        if (!threadId) {
          console.warn('[DesktopRelay] Dropping done frame without thread_id/conversationId');
          return;
        }
        const committed = finalTextByThread.get(threadId);
        const finalText = committed ?? streamedByThread.get(threadId) ?? '';
        // Streaming-only runs never hit the `progress` branch, so their text
        // was never scribed. Committed (progress) text was already written.
        let doneId: string | undefined;
        if (!committed && finalText) {
          const ts = new Date().toISOString();
          doneId = deriveMessageId(threadId, 'assistant', finalText, ts);
          await this.scribeTurn(threadId, 'assistant', finalText, { id: doneId, ts });
        }
        streamedByThread.delete(threadId);
        finalTextByThread.delete(threadId);
        lastActivityByThread.delete(threadId);
        // Stop the keepalive — run is complete.
        const t = this.keepaliveTimers.get(threadId);
        if (t) { clearInterval(t); this.keepaliveTimers.delete(threadId); }
        this.activeConversations.delete(threadId);
        this.sendChatFrame(threadId, { type: 'done', content: finalText, id: doneId });
        return;
      }

      if (msg.type === 'thread_created') {
        // Agent created a new threadId for this conversation. Mobile uses
        // its own conversationId scheme; we don't need to plumb this back.
        return;
      }
    });
  }

  private sendMissingConversationError(userMessageId?: string) {
    // D1 rejection is the one intentional exception to the outbound
    // conversationId guard: the inbound frame was malformed, so there is no
    // route id to stamp.
    this.sendUnchecked({ type: 'error', reason: 'missing_conversation_id', userMessageId });
  }

  private sendChatFrame(conversationId: string | undefined, payload: Record<string, unknown>) {
    if (!conversationId) {
      const type = typeof payload.type === 'string' ? payload.type : 'unknown';
      console.error(`[DesktopRelay] BUG: refusing to send ${ type } frame without conversationId`);
      return;
    }
    this.send({ ...payload, conversationId });
  }

  private sendUnchecked(payload: Record<string, unknown>) {
    const json = JSON.stringify(payload);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[DesktopRelay] Dropped malformed-frame error — socket not open');
      return;
    }
    try {
      this.ws.send(json);
    } catch (err) {
      console.warn('[DesktopRelay] Send failed:', err);
    }
  }

  private send(payload: Record<string, unknown>) {
    const type = typeof payload.type === 'string' ? payload.type : undefined;
    if (type && this.requiresConversationId(type) && typeof payload.conversationId !== 'string') {
      console.error(`[DesktopRelay] BUG: refusing to send ${ type } frame without conversationId`);
      return;
    }
    const json = JSON.stringify(payload);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue completion/error frames so they're delivered after reconnect.
      // Streaming/activity frames are ephemeral — dropping them is acceptable.
      if (type === 'done' || type === 'stopped' || type === 'error' || type === 'message' || type === 'ack') {
        this.pendingFrames.push(json);
        console.warn(`[DesktopRelay] Queued ${ type } frame — socket not open`);
      } else {
        console.warn('[DesktopRelay] Dropped frame — socket not open:', type);
      }
      return;
    }
    try {
      this.ws.send(json);
      // A successful forward implies the peer accepted the frame at least once
      // recently. Resume keepalives if we had paused on peer_offline.
      if (!this.mobilePeerOnline) {
        this.mobilePeerOnline = true;
        for (const convId of this.activeConversations) {
          this.startKeepalive(convId);
        }
      }
    } catch (err) {
      console.warn('[DesktopRelay] Send failed:', err);
    }
  }

  private startKeepalive(conversationId: string) {
    if (this.keepaliveTimers.has(conversationId)) return;
    const timer = setInterval(() => {
      if (!this.keepaliveTimers.has(conversationId)) return;
      this.sendChatFrame(conversationId, { type: 'keepalive' });
    }, 15_000);
    this.keepaliveTimers.set(conversationId, timer);
    // Safety valve: clear after 10 min regardless — prevents leaks if the
    // agent crashes without emitting graph_execution_complete.
    setTimeout(() => {
      const t = this.keepaliveTimers.get(conversationId);
      if (t) { clearInterval(t); this.keepaliveTimers.delete(conversationId); }
    }, 10 * 60 * 1_000);
  }

  private requiresConversationId(type: string): boolean {
    return type === 'ack' || type === 'activity' || type === 'chunk' || type === 'done' ||
      type === 'error' || type === 'keepalive' || type === 'message' || type === 'stopped';
  }

  /**
   * Write a committed relay turn to the sync log (local claude_messages +
   * sync_queue push). Scribing failures are logged, never thrown — the
   * real-time WS path must survive a bad DB write, and SullaSyncService
   * retries cloud delivery on its own. Turns without a conversationId are
   * skipped — in that case the agent runs under a self-created `thread_…`
   * id and the SullaLogger mirror is the scribe instead.
   */
  private async scribeTurn(conversationId: string | undefined, role: 'user' | 'assistant' | 'tool', content: string, opts?: { id?: string, ts?: string }): Promise<void> {
    if (!conversationId || !content.trim()) return;
    await scribeRelayTurn({
      conversationId, role, content, ts: opts?.ts ?? new Date().toISOString(), id: opts?.id,
    }).catch((err) => {
      console.warn(`[DesktopRelay] Failed to scribe ${ role } turn for ${ conversationId }:`, err);
    });
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

  // Kick off the connection on load if a pairing already exists. start()
  // reads the pairing from Postgres, which may still be coming up inside the
  // VM on a cold boot — retry with a flat backoff instead of dying once and
  // leaving the relay offline until the next app restart.
  (async() => {
    const RETRY_MS = 10_000;
    const DEADLINE_MS = 5 * 60_000;
    const t0 = Date.now();

    for (;;) {
      try {
        await client.start();

        return;
      } catch (err) {
        if (Date.now() - t0 >= DEADLINE_MS) {
          console.error('[DesktopRelay] start() still failing after 5min — giving up until next app start:', err);

          return;
        }
        console.warn(`[DesktopRelay] start() failed (retrying in ${ RETRY_MS / 1000 }s):`, err instanceof Error ? err.message : err);
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      }
    }
  })();
}
