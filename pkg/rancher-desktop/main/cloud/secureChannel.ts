/**
 * Secure desktop channel — the desktop end.
 *
 * Keeps one WebSocket to Sulla Cloud's DesktopChannel for THIS device while
 * the owner is signed in. Every connect uses a single-use ticket that the
 * cloud only issues after checking an Ed25519 signature from this
 * machine's device key (deviceKey.ts). No access token ever goes in a URL.
 *
 * Inbound frames are client envelopes stamped by the cloud. Two kinds:
 *
 *   pair_request  A browser/phone wants to control this desktop. The owner
 *                 sees a native dialog with a 6-digit code (also shown in
 *                 the browser) and must click Allow here. Nothing remote
 *                 can approve a client.
 *   signed        A command signed by an approved client key. Verified by
 *                 secureChannelProtocol.verifySignedFrame, then handed to
 *                 the same agent bridge the mobile relay uses.
 *
 * Remote access can be switched off in Settings → Sulla Cloud; then every
 * command is refused with `remote_access_disabled` and the cloud stops
 * issuing client tickets.
 */

import { getDesktopDeviceId } from '../deviceIdentity';
import { getCurrentAccessToken, getCurrentUserId } from '../sullaCloudAuth';
import { ApprovedClients } from './approvedClients';
import { CLOUD_API_BASE } from './cloudEndpoints';
import { getCloudPreferences } from './cloudSettings';
import { signDeviceMessage } from './deviceKey';
import {
  checkPairRequest, NonceCache, pairingCode, verifySignedFrame, type ClientFrameEnvelope,
} from './secureChannelProtocol';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 20_000;
const STALE_SOCKET_MS = 50_000;
const PAIR_WINDOW_MS = 10 * 60_000;
const MAX_PAIR_PROMPTS_PER_WINDOW = 5;

export interface SecureChannelStatus {
  state:           'stopped' | 'connecting' | 'connected' | 'error';
  lastError?:      string;
  approvedClients: number;
}

export type PairingPrompt = (req: { label: string; surface: string; code: string }) => Promise<boolean>;

interface Deps {
  prompt:   PairingPrompt;
  dispatch: (body: Record<string, any>, reply: (frame: Record<string, unknown>) => void, respond: (frame: Record<string, unknown>) => void) => Promise<void>;
  audit?:   (event: string, detail: Record<string, unknown>) => void;
}

export class SecureDesktopChannel {
  private ws:              WebSocket | null = null;
  private running = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer:  ReturnType<typeof setTimeout> | null = null;
  private pingTimer:       ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private state:           SecureChannelStatus['state'] = 'stopped';
  private lastError = '';
  private nonces = new NonceCache();
  private pairingInFlight = false;
  private pairPromptTimes: number[] = [];
  // conversationId → clients following it (they get every frame for it).
  private subscribers = new Map<string, Set<string>>();
  private listeners:       ((s: SecureChannelStatus) => void)[] = [];
  private deviceId = '';
  private userId = '';

  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.connect().catch(() => undefined);
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.teardown();
    this.setState('stopped');
  }

  /** Force a fresh connect (resume from sleep, sign-in, settings change). */
  reconnect(): void {
    if (!this.running) return;
    this.teardown();
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.connect().catch(() => undefined);
  }

  getStatus(): SecureChannelStatus {
    return { state: this.state, lastError: this.lastError || undefined, approvedClients: ApprovedClients.list().length };
  }

  onStatus(l: (s: SecureChannelStatus) => void): () => void {
    this.listeners.push(l);
    return () => { this.listeners = this.listeners.filter(x => x !== l) };
  }

  /** Revoke an approved browser/phone: forget its key and kick its socket. */
  revokeClient(clientId: string): boolean {
    const removed = ApprovedClients.remove(clientId);
    for (const subs of this.subscribers.values()) subs.delete(clientId);
    this.sendRaw({ type: 'revoke_client', clientId });
    this.deps.audit?.('client_revoked', { clientId });
    this.broadcastStatus();
    return removed;
  }

  // ── Connection ────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.setState('connecting');
    try {
      const token = await getCurrentAccessToken();
      const userId = await getCurrentUserId();
      if (!token || !userId) throw new Error('not signed in to Sulla Cloud');
      this.deviceId = await getDesktopDeviceId();
      this.userId = userId;

      const proof = signDeviceMessage('relay-desktop', [userId, this.deviceId]);
      const res = await fetch(`${ CLOUD_API_BASE }/desktop-channel/tickets`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ token }` },
        body:    JSON.stringify({ deviceId: this.deviceId, role: 'desktop', ts: proof.ts, signature: proof.signature }),
      });
      const body = await res.json().catch(() => ({})) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        // Key not enrolled yet / device revoked: the lifecycle re-registers
        // on its next heartbeat; keep backing off meanwhile.
        throw new Error(body.error || `ticket request failed (${ res.status })`);
      }
      if (!this.running) return;
      this.open(body.url);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState('error');
      this.scheduleReconnect();
    }
  }

  private open(url: string) {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.lastInboundAt = Date.now();
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.lastError = '';
      this.setState('connected');
      console.log('[SecureChannel] Connected');
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastInboundAt > STALE_SOCKET_MS) { this.fail('no inbound traffic'); return }
        try { ws.send(JSON.stringify({ type: 'ping' })) } catch { /* watchdog handles it */ }
      }, PING_INTERVAL_MS);
    });
    ws.addEventListener('message', (ev) => {
      this.lastInboundAt = Date.now();
      this.onMessage(String(ev.data)).catch(() => undefined);
    });
    ws.addEventListener('close', (ev: any) => {
      if (this.ws !== ws) return;
      const reason = ev?.reason ? String(ev.reason) : '';
      if (reason === 'device_revoked') this.lastError = 'This desktop was removed from your Sulla Cloud account.';
      this.fail(reason || 'socket closed');
    });
    ws.addEventListener('error', () => {
      if (this.ws === ws) this.fail('socket error');
    });
  }

  private fail(reason: string) {
    this.teardown();
    if (!this.lastError) this.lastError = reason;
    this.setState('error');
    this.scheduleReconnect();
  }

  private teardown() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close() } catch { /* already closed */ }
    }
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => undefined);
    }, delay);
  }

  // ── Inbound ───────────────────────────────────────────────

  /** Exposed for tests. */
  async onMessage(raw: string): Promise<void> {
    let env: ClientFrameEnvelope & { type: string };
    try { env = JSON.parse(raw) } catch { return }
    if (env?.type !== 'client_frame') return; // connected/pong/error from the relay itself
    const clientId = env.from?.clientId;
    if (!clientId) return;

    if (env.kind === 'pair_request') {
      await this.onPairRequest(env);
      return;
    }

    const prefs = await getCloudPreferences();
    if (!prefs.remoteAccess) {
      this.deliver(clientId, { type: 'error', reason: 'remote_access_disabled' });
      return;
    }

    const result = verifySignedFrame(env, {
      ownUserId: this.userId,
      deviceId:  this.deviceId,
      approved:  id => ApprovedClients.get(id),
      nonces:    this.nonces,
    });
    if (!result.ok) {
      // Tell the client why (it can re-pair on client_not_approved); log the rest.
      this.deliver(clientId, { type: 'error', reason: result.reason });
      if (result.reason !== 'client_not_approved') this.deps.audit?.('command_rejected', { clientId, reason: result.reason });
      return;
    }

    ApprovedClients.touch(clientId);
    const { body } = result.command;
    const conversationId = typeof body.conversationId === 'string'
      ? body.conversationId
      : typeof body.params?.conversationId === 'string' ? body.params.conversationId : '';
    if (conversationId) this.subscribe(conversationId, clientId);

    const reply = (frame: Record<string, unknown>) => {
      const subs = conversationId ? this.subscribers.get(conversationId) : undefined;
      for (const id of subs ?? [clientId]) this.deliver(id, frame);
    };
    const respond = (frame: Record<string, unknown>) => this.deliver(clientId, frame);
    try {
      await this.deps.dispatch(body, reply, respond);
    } catch (err) {
      respond({ type: 'error', reason: 'dispatch_failed', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async onPairRequest(env: ClientFrameEnvelope) {
    const check = checkPairRequest(env, this.userId);
    const replyTo = env.from?.clientId ?? '';
    if (!check.ok) {
      this.deliver(replyTo, { type: 'pair_result', approved: false, reason: check.reason });
      return;
    }
    if (ApprovedClients.get(check.clientId)) {
      this.deliver(check.clientId, { type: 'pair_result', approved: true, already: true });
      return;
    }
    const prefs = await getCloudPreferences();
    if (!prefs.remoteAccess) {
      this.deliver(check.clientId, { type: 'pair_result', approved: false, reason: 'remote_access_disabled' });
      return;
    }
    const now = Date.now();
    this.pairPromptTimes = this.pairPromptTimes.filter(t => now - t < PAIR_WINDOW_MS);
    if (this.pairingInFlight || this.pairPromptTimes.length >= MAX_PAIR_PROMPTS_PER_WINDOW) {
      this.deliver(check.clientId, { type: 'pair_result', approved: false, reason: 'pairing_busy' });
      return;
    }
    this.pairingInFlight = true;
    this.pairPromptTimes.push(now);
    const code = pairingCode(this.deviceId, check.publicKey);
    this.deliver(check.clientId, { type: 'pair_pending', code });
    try {
      const approved = await this.deps.prompt({ label: check.label, surface: check.surface, code });
      if (approved) {
        ApprovedClients.add({
          clientId: check.clientId, publicKey: check.publicKey, label: check.label, surface: check.surface, approvedAt: new Date().toISOString(),
        });
        this.deps.audit?.('client_approved', { clientId: check.clientId, label: check.label });
      } else {
        this.deps.audit?.('client_denied', { clientId: check.clientId, label: check.label });
      }
      this.deliver(check.clientId, { type: 'pair_result', approved });
      this.broadcastStatus();
    } finally {
      this.pairingInFlight = false;
    }
  }

  private subscribe(conversationId: string, clientId: string) {
    let set = this.subscribers.get(conversationId);
    if (!set) {
      set = new Set();
      this.subscribers.set(conversationId, set);
      while (this.subscribers.size > 500) this.subscribers.delete(this.subscribers.keys().next().value!);
    }
    set.add(clientId);
  }

  // ── Outbound ──────────────────────────────────────────────

  private deliver(clientId: string, frame: Record<string, unknown>) {
    if (!clientId) return;
    this.sendRaw({ type: 'deliver', to: clientId, frame });
  }

  private sendRaw(msg: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(msg)) } catch (err) { console.warn('[SecureChannel] send failed:', err) }
  }

  private setState(state: SecureChannelStatus['state']) {
    this.state = state;
    this.broadcastStatus();
  }

  private broadcastStatus() {
    const s = this.getStatus();
    for (const l of this.listeners) {
      try { l(s) } catch { /* ignore */ }
    }
  }

  /** Test seam: pretend we're connected as this user/device. */
  _setIdentity(userId: string, deviceId: string, ws?: any) {
    this.userId = userId;
    this.deviceId = deviceId;
    if (ws) this.ws = ws;
  }
}
