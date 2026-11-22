// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { desktopDeviceIdentity } from '../device/DesktopDeviceIdentity';
import { CLOUD_API_BASE, CLOUD_RELAY_BASE } from '../cloudEndpoints';
import { signDeviceMessageExact } from '../deviceKey';

import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { getActiveContractorId, getCurrentAccessToken, getCurrentUserId } from '@pkg/main/sullaCloudAuth';

type Frame = Record<string, unknown>;

export class RemoteChatViewer {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private generation = 0;
  private account = '';
  private workspace = '';
  private device = '';
  private localIdentity = '';
  private historyOnly = false;
  private readonly subscriptions = new Map<string, string>();
  private readonly pendingSubscriptions = new Map<string, { host: string; id: string }>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastPong = 0;

  constructor(private readonly emit: (message: Frame) => void) {}

  async connect(bound = false): Promise<void> {
    if (this.connecting) return this.connecting;
    const task = this.open(bound).finally(() => { if (this.connecting === task) this.connecting = undefined });
    this.connecting = task;
    return task;
  }

  async checkIdentity(): Promise<{ account: string; device: string }> {
    const [account, device, contractor] = await Promise.all([getCurrentUserId(), getDesktopDeviceId(), getActiveContractorId()]);
    const identity = account && device ? JSON.stringify([account, device, contractor]) : '';
    if (identity !== this.localIdentity) {
      this.localIdentity = identity;
      this.reset(true);
    }
    return { account, device };
  }

  private async open(bound: boolean): Promise<void> {
    const { account, device } = await this.checkIdentity();
    const historyOnly = process.env.SULLA_SHARED_LIVE_RELAY !== 'on';
    if (historyOnly && !bound) return;
    if (this.socket && this.account === account) return;
    this.reset();
    const generation = this.generation;
    const token = await getCurrentAccessToken();
    if (!account || !token || !device || generation !== this.generation || account !== await getCurrentUserId()) return;
    this.account = account;
    this.device = device;
    this.historyOnly = historyOnly;
    const url = new URL(`/relay/${ encodeURIComponent(account) }`, CLOUD_RELAY_BASE);
    url.search = new URLSearchParams({ role: 'viewer', deviceId: device, token, ...(historyOnly ? { historyOnly: '1' } : {}) }).toString();
    const socket = new WebSocket(url);
    this.socket = socket;
    const active = () => this.socket === socket;
    const timeout = setTimeout(() => { if (active() && !this.workspace) this.reset() }, 10000);
    let inbound = Promise.resolve();
    const receive = async(event: MessageEvent) => {
      if (!active() || typeof event.data !== 'string') return;
      let frame: Frame;
      try { frame = JSON.parse(event.data) } catch { return }
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'relay_device_challenge' && typeof frame.nonce === 'string') {
        try {
          const signature = await signDeviceMessageExact('shared-live-relay-v1', [account, 'viewer', device, frame.nonce]);
          if (active()) socket.send(JSON.stringify({ type: 'relay_device_proof', signature }));
        } catch { if (active()) this.reset() }
        return;
      }
      if (frame.type === 'error' && !this.workspace && frame.reason === 'thread_not_authorized') {
        this.reset(true);
        return;
      }
      if (frame.type === 'pong') { this.lastPong = Date.now(); return }
      if (frame.type === 'relay_device_ready' && typeof frame.workspaceId === 'string') {
        clearTimeout(timeout);
        this.workspace = frame.workspaceId;
        this.historyOnly ||= frame.historyOnly === true;
        clearInterval(this.heartbeat);
        this.lastPong = Date.now();
        this.heartbeat = setInterval(() => {
          if (!active()) return;
          if (Date.now() - this.lastPong > 30000) { this.reset(); return }
          try { socket.send('{"type":"ping"}') } catch { this.reset() }
        }, 10000);
      }
      if (!this.workspace) return;
      if (account !== await getCurrentUserId() || !active()) { if (active()) this.reset(); return }
      if (typeof frame.conversationId === 'string') {
        const request = this.pendingSubscriptions.get(frame.conversationId);
        if (request && request.host === frame.deviceId && ((frame.type === 'ack' && frame.userMessageId === request.id)
            || (frame.type === 'relay_subscribed' && frame.subscriptionId === request.id))) {
          if (frame.historyOnly === true) this.historyOnly = true;
          this.subscriptions.set(frame.conversationId, request.host);
          this.pendingSubscriptions.delete(frame.conversationId);
        }
      }
      this.emit(frame.type === 'relay_device_ready' ? { ...frame, ...this.context() } : frame);
    };
    socket.addEventListener('message', event => {
      inbound = inbound.then(() => receive(event)).catch(() => { if (active()) this.reset() });
    });
    socket.addEventListener('close', event => {
      clearTimeout(timeout);
      if (active()) this.reset(event.code === 4403);
    });
    // Close carries the authorization rejection code; the opening timeout covers failed handshakes.
  }

  reset(invalidate = false): void {
    this.generation++;
    const old = this.socket;
    this.socket = undefined;
    this.account = this.workspace = this.device = '';
    this.subscriptions.clear();
    this.pendingSubscriptions.clear();
    clearInterval(this.heartbeat);
    old?.close();
    this.emit({ type: invalidate ? 'viewer_invalidated' : 'viewer_disconnected' });
  }

  ready(): boolean { return this.socket?.readyState === WebSocket.OPEN && !!this.workspace }

  context(): { accountId: string; workspaceId: string; deviceId: string; historyOnly: boolean } | null {
    return this.ready() ? { accountId: this.account, workspaceId: this.workspace, deviceId: this.device, historyOnly: this.historyOnly } : null;
  }

  async send(value: unknown): Promise<boolean> {
    const socket = this.socket;
    const account = this.account;
    if (!this.ready() || account !== await getCurrentUserId() || socket !== this.socket
        || !value || typeof value !== 'object') return false;
    const frame = value as Frame;
    const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v);
    if ((this.historyOnly || process.env.SULLA_SHARED_LIVE_RELAY !== 'on')
        && frame.type !== 'relay_subscribe' && frame.type !== 'relay_unsubscribe') return false;
    let command: Frame;
    if (frame.type === 'relay_inventory' && id(frame.requestId)) {
      const cached = Array.isArray(frame.cached) ? frame.cached.slice(0, 24).flatMap(item =>
        item && id(item.id) && /^[a-f0-9]{64}$/.test(item.keyTag) ? [{ id: item.id, keyTag: item.keyTag }] : []) : [];
      command = { type: frame.type, requestId: frame.requestId, cached };
    } else {
      if (typeof frame.conversationId !== 'string' || !/^remote_[A-Za-z0-9_-]{12,180}$/.test(frame.conversationId)
          || typeof frame.targetDeviceId !== 'string' || !id(frame.targetDeviceId)) return false;
      command = { type: frame.type, relayScope: 'v1', conversationId: frame.conversationId, targetDeviceId: frame.targetDeviceId };
      switch (frame.type) {
      case 'relay_subscribe':
        if (!id(frame.subscriptionId)) return false;
        command.subscriptionId = frame.subscriptionId;
        this.pendingSubscriptions.set(frame.conversationId, { host: frame.targetDeviceId, id: String(frame.subscriptionId) });
        break;
      case 'relay_unsubscribe':
        this.subscriptions.delete(frame.conversationId);
        this.pendingSubscriptions.delete(frame.conversationId);
        break;
      case 'relay_receipt':
        if (!id(frame.userMessageId)) return false;
        command.userMessageId = frame.userMessageId;
        break;
      case 'cancel':
        if (!id(frame.clientRunId)) return false;
        command.clientRunId = frame.clientRunId;
        break;
      case 'chat':
        if (!id(frame.userMessageId) || typeof frame.text !== 'string' || !frame.text.trim() || frame.text.length > 128000
            || typeof frame.providerId !== 'string' || !frame.providerId || frame.providerId.length > 200
            || typeof frame.modelId !== 'string' || !frame.modelId || frame.modelId.length > 200
            || (frame.agentId != null && !id(frame.agentId))) return false;
        this.pendingSubscriptions.set(frame.conversationId, { host: frame.targetDeviceId, id: String(frame.userMessageId) });
        Object.assign(command, {
          userMessageId: frame.userMessageId, providerId: frame.providerId, modelId: frame.modelId,
          agentId: frame.agentId, messages: [{ role: 'user', content: frame.text }],
        });
        break;
      default: return false;
      }
    }
    if (!socket) return false;
    try { socket.send(JSON.stringify(command)); return true } catch { return false }
  }

  async history(thread: unknown, cursor: unknown, ids: unknown, reconcileOnly: unknown): Promise<unknown> {
    if (!this.ready() || typeof thread !== 'string' || !this.subscriptions.has(thread)
        || typeof cursor !== 'string' || cursor.length > 2048 || !Array.isArray(ids) || ids.length > 96
        || !ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id))) return { status: 403 };
    const generation = this.generation;
    const { account, workspace, device } = this;
    const query = new URLSearchParams({ cursor, limit: '100' });
    if (reconcileOnly === true) query.set('reconcileOnly', '1');
    for (const id of ids) query.append('reconcileId', id);
    const target = `/chat/conversations/${ thread }/messages?${ query }`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const token = await getCurrentAccessToken();
      if (!token || generation !== this.generation || account !== await getCurrentUserId()) return { status: 403 };
      const bytes = Buffer.from(JSON.stringify(['sulla-shared-history-v1', account, workspace, thread, device, target, timestamp]), 'utf8');
      const signature = await desktopDeviceIdentity().signBytes(bytes);
      const response = await fetch(new URL(target, CLOUD_API_BASE), {
        redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Authorization: `Bearer ${ token }`, 'X-Sulla-History-Device': device,
          'X-Sulla-History-Time': timestamp, 'X-Sulla-History-Signature': signature },
      });
      const page = response.ok ? await response.json() : undefined;
      if (generation !== this.generation || account !== await getCurrentUserId()) return { status: 403 };
      return { status: response.status, page };
    } catch { return { status: 503 } }
  }
}
