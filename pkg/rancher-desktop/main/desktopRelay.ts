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
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

const RELAY_URL = 'wss://sulla-workers.jonathon-44b.workers.dev';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 30_000;

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
  // conversationId → AbortController for in-flight chat requests. Mobile can
  // send a `{type:'cancel', conversationId}` frame to stop a run; we call
  // .abort() on the matching controller which propagates through ClaudeCodeService
  // to the limactl process and the in-VM claude CLI.
  private inFlightAborts = new Map<string, AbortController>();

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
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.currentRoom = null;
    this.connected = false;
    this.broadcastStatus();
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

    ws.addEventListener('open', () => {
      this.connected = true;
      this.lastError = '';
      this.reconnectDelay = RECONNECT_BASE_MS;
      console.log(`[DesktopRelay] Connected — room=${ room }`);
      this.broadcastStatus();
    });

    ws.addEventListener('message', (event) => {
      this.handleMessage(event.data as string);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      console.log('[DesktopRelay] Socket closed');
      this.broadcastStatus();
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });

    ws.addEventListener('error', (e: any) => {
      this.lastError = e?.message || 'WebSocket error';
      console.warn('[DesktopRelay] Error:', this.lastError);
      this.broadcastStatus();
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
      // Mobile hit the stop button. Abort any in-flight chatStream for this
      // conversation — propagates to ClaudeCodeService → limactl kill + VM pkill.
      const key = msg.conversationId ?? this.currentRoom ?? '__default__';
      const ctrl = this.inFlightAborts.get(key);
      if (ctrl) {
        console.log(`[DesktopRelay] Cancel received for conversationId=${ key }`);
        try { ctrl.abort() } catch { /* already aborted */ }
        this.inFlightAborts.delete(key);
      } else {
        console.log(`[DesktopRelay] Cancel received for conversationId=${ key } — no in-flight request`);
      }
      return;
    }

    console.log(`[DesktopRelay] Unknown message type: ${ msg.type }`);
  }

  private async handleChatRequest(msg: IncomingMessage) {
    const messages = msg.messages ?? [];
    // Prefer the per-thread conversation id from mobile; fall back to the room
    // (= user id) so older mobile clients still work, but sessions collide.
    const conversationId = msg.conversationId ?? this.currentRoom ?? undefined;
    const abortKey = conversationId ?? '__default__';
    console.log(`[DesktopRelay] Chat request — ${ messages.length } messages, conversationId=${ conversationId ?? '(none)' }`);

    // If a prior chat for this conversation is still running (user tapped
    // send twice without stop), abort it so we don't fan out two parallel
    // claude processes for the same thread.
    const prior = this.inFlightAborts.get(abortKey);
    if (prior) {
      try { prior.abort() } catch { /* already aborted */ }
      this.inFlightAborts.delete(abortKey);
    }

    const abortController = new AbortController();
    this.inFlightAborts.set(abortKey, abortController);

    try {
      const { getClaudeCodeService } = await import('@pkg/agent/languagemodels/ClaudeCodeService');
      const svc = getClaudeCodeService();

      // Stream each text delta to mobile as it arrives, then emit a final
      // `done` with the full content so clients that missed chunks still get
      // the whole reply. De-dupe consecutive activity messages so "Using
      // Bash…" then "$ ls /etc" doesn't spam the mobile thinking bubble.
      let lastActivity = '';
      const result = await svc.chatStream(
        messages as any,
        {
          onToken: (delta: string) => {
            if (delta) this.send({ type: 'chunk', delta });
          },
          onActivity: (message: string) => {
            if (!message || message === lastActivity) return;
            lastActivity = message;
            this.send({ type: 'activity', message });
          },
        },
        { conversationId, signal: abortController.signal },
      );

      const content = result?.content ?? '';
      this.send({ type: 'done', content });
    } catch (err: any) {
      const message = err?.message || 'Claude Code failed';
      // Treat AbortError as a clean cancel, not a chat failure.
      if (abortController.signal.aborted || /abort/i.test(message)) {
        console.log(`[DesktopRelay] Chat aborted for conversationId=${ conversationId ?? '(none)' }`);
        this.send({ type: 'cancelled' });
      } else {
        console.warn('[DesktopRelay] Chat handler failed:', message);
        this.send({ type: 'error', reason: message });
      }
    } finally {
      // Only remove the controller if it's still ours — a later chat request
      // or a cancel frame may have already replaced/removed it.
      if (this.inFlightAborts.get(abortKey) === abortController) {
        this.inFlightAborts.delete(abortKey);
      }
    }
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
