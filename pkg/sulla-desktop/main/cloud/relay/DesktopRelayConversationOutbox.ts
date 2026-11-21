// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DesktopRelayLog, DesktopRelayTimers, RelayFrame, RelayFrameSink, RelayInterval, ScopedRelayBinding } from './DesktopRelayPorts';

const KEEPALIVE_INTERVAL_MS = 15_000;
// Safety valve: clear a keepalive after 10 min regardless — prevents leaks if
// the agent crashes without emitting graph_execution_complete.
const KEEPALIVE_MAX_MS = 10 * 60 * 1_000;
const MAX_SECURE_ROUTES = 500;
const CONVERSATION_FRAME_TYPES: readonly string[] = ['ack', 'activity', 'chunk', 'done', 'error', 'keepalive', 'message', 'stopped'];

/** The relay socket as the outbox sees it. */
export interface DesktopRelayFrameTransport {
  readonly deviceId: string;
  send(payload: RelayFrame, type: string | undefined): void;
  sendUnchecked(payload: RelayFrame): void;
}

/**
 * Per-conversation relay state and the outbound chat-frame path: run-id
 * stamping, secure-channel routes, the in-flight run order and the mobile
 * keepalives that stop the phone timing out during long tool runs.
 */
export class DesktopRelayConversationOutbox {
  // Conversations started over the secure desktop channel (Sulla Cloud
  // dashboard). Their frames go back through the channel to the approved
  // client that sent them, never to the legacy mobile relay room.
  private readonly secureRoutes = new Map<string, RelayFrameSink>();
  // Per-conversation keepalive timers, keyed by conversationId (the agent threadId).
  private readonly keepaliveTimers = new Map<string, RelayInterval>();
  // Conversations with an in-flight agent run. Keepalive only runs while the
  // mobile peer is online; peer_offline pauses it so we don't spam the DO.
  private readonly activeConversations = new Set<string>();
  // Runs are ordered per thread because an aborted graph can emit its final
  // completion after mobile has already submitted the replacement turn.
  // Keeping the ids in graph-event order prevents that stale completion from
  // being stamped as (and therefore ending) the replacement run.
  private readonly relayRuns = new Map<string, string[]>();
  private readonly scopedRuns = new Map<string, { id: string; scope: ScopedRelayBinding }>();
  private mobilePeerOnline = true;

  constructor(
    private readonly transport: DesktopRelayFrameTransport,
    private readonly timers: DesktopRelayTimers,
    private readonly log: DesktopRelayLog,
    private readonly approvals: () => readonly (readonly [string, string])[] = () => [],
  ) {}

  /** Send a conversation frame, stamped with its run id, to its secure route or the relay room. */
  sendChatFrame(conversationId: string | undefined, payload: RelayFrame): void {
    if (!conversationId) {
      const type = typeof payload.type === 'string' ? payload.type : 'unknown';
      this.log.error(`[DesktopRelay] BUG: refusing to send ${ type } frame without conversationId`);
      return;
    }
    const runId = typeof payload.clientRunId === 'string'
      ? payload.clientRunId
      : this.relayRuns.get(conversationId)?.[0];
    const stamped = runId ? { ...payload, clientRunId: runId, userMessageId: payload.userMessageId ?? runId } : payload;
    if (conversationId.startsWith('remote_')) {
      this.sendScoped(conversationId, stamped);
      return;
    }
    const secure = this.secureRoutes.get(conversationId);
    if (secure) {
      try {
        secure({ ...stamped, conversationId, deviceId: this.transport.deviceId });
      } catch (err) {
        this.log.warn('[DesktopRelay] Secure route send failed:', err);
      }
      return;
    }
    this.send({ ...stamped, conversationId, deviceId: this.transport.deviceId });
  }

  sendScoped(conversationId: string, payload: RelayFrame, request?: string): void {
    // Scope metadata is rebuilt by the host, never copied from viewer input.
    this.send({ ...payload, conversationId, deviceId: this.transport.deviceId, relayScope: 'v1',
      relayApprovals: this.approvals(), ...(request ? { relayRequest: request } : {}) });
  }

  activeRun(conversationId: string): string | undefined {
    return this.activeConversations.has(conversationId) ? this.oldestRun(conversationId) : undefined;
  }

  /** Relay-room send that refuses conversation frames missing their conversationId. */
  send(payload: RelayFrame): void {
    const type = typeof payload.type === 'string' ? payload.type : undefined;
    if (type && CONVERSATION_FRAME_TYPES.includes(type) && typeof payload.conversationId !== 'string') {
      this.log.error(`[DesktopRelay] BUG: refusing to send ${ type } frame without conversationId`);
      return;
    }
    this.transport.send(payload, type);
  }

  sendMissingConversationError(userMessageId?: string): void {
    // The one intentional exception to the outbound conversationId guard: the
    // inbound frame was malformed, so there is no route id to stamp.
    this.transport.sendUnchecked({ type: 'error', reason: 'missing_conversation_id', userMessageId });
  }

  setSecureRoute(conversationId: string, reply: RelayFrameSink): void {
    this.secureRoutes.delete(conversationId);
    this.secureRoutes.set(conversationId, reply);
    // Bounded: oldest routes fall back to the legacy relay (and history sync).
    while (this.secureRoutes.size > MAX_SECURE_ROUTES) this.secureRoutes.delete(this.secureRoutes.keys().next().value!);
  }

  clearSecureRoute(conversationId: string): void {
    this.secureRoutes.delete(conversationId);
  }

  /** Record a run id in submission order. */
  registerRun(conversationId: string, runId: string, scope?: ScopedRelayBinding): void {
    if (scope) this.scopedRuns.set(conversationId, { id: runId, scope });
    const runs = this.relayRuns.get(conversationId) ?? [];
    if (!runs.includes(runId)) runs.push(runId);
    this.relayRuns.set(conversationId, runs);
  }

  scopedBinding(conversationId: string, runId: string): ScopedRelayBinding | undefined {
    const binding = this.scopedRuns.get(conversationId);
    return binding?.id === runId ? binding.scope : undefined;
  }

  oldestRun(conversationId: string): string | undefined {
    return this.relayRuns.get(conversationId)?.[0];
  }

  /** A new agent run is in flight: keep mobile's socket warm while it runs. */
  beginRun(conversationId: string): void {
    this.activeConversations.add(conversationId);
    if (this.mobilePeerOnline || this.secureRoutes.has(conversationId)) this.startKeepalive(conversationId);
  }

  /** Mobile cancelled the run: stop its keepalive and forget it. */
  cancelRun(conversationId: string): void {
    this.stopKeepalive(conversationId);
    this.activeConversations.delete(conversationId);
  }

  /**
   * Graph completion: stop liveness only when this is still the newest run,
   * send `done`, then retire the oldest run id.
   */
  completeRun(conversationId: string, done: RelayFrame): void {
    const runs = this.relayRuns.get(conversationId);
    if (!runs || runs.length <= 1) {
      this.stopKeepalive(conversationId);
      this.activeConversations.delete(conversationId);
    }
    this.sendChatFrame(conversationId, done);
    this.scopedRuns.delete(conversationId);
    if (runs?.length) runs.shift();
    if (!runs?.length) this.relayRuns.delete(conversationId);
  }

  activeConversationIds(): string[] {
    return [...this.activeConversations];
  }

  /** The relay reported the mobile peer back (or a frame went through). */
  peerOnline(): void {
    this.mobilePeerOnline = true;
    for (const convId of this.activeConversations) this.startKeepalive(convId);
  }

  peerOffline(): void {
    if (this.mobilePeerOnline) this.log.warn('[DesktopRelay] Mobile peer offline — pausing keepalives until reconnect');
    this.mobilePeerOnline = false;
    for (const timer of this.keepaliveTimers.values()) this.timers.clearInterval(timer);
    this.keepaliveTimers.clear();
  }

  /** A successful forward implies the peer accepted a frame recently; resume paused keepalives. */
  frameDelivered(): void {
    if (!this.mobilePeerOnline) this.peerOnline();
  }

  /** The pairing was dropped: forget every conversation. */
  reset(): void {
    for (const t of this.keepaliveTimers.values()) this.timers.clearInterval(t);
    this.keepaliveTimers.clear();
    this.activeConversations.clear();
    this.relayRuns.clear();
    this.scopedRuns.clear();
    this.mobilePeerOnline = true;
  }

  private startKeepalive(conversationId: string): void {
    if (this.keepaliveTimers.has(conversationId)) return;
    const timer = this.timers.setInterval(() => {
      if (!this.keepaliveTimers.has(conversationId)) return;
      this.sendChatFrame(conversationId, { type: 'keepalive' });
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimers.set(conversationId, timer);
    this.timers.setTimeout(() => this.stopKeepalive(conversationId), KEEPALIVE_MAX_MS);
  }

  private stopKeepalive(conversationId: string): void {
    const t = this.keepaliveTimers.get(conversationId);
    if (t) { this.timers.clearInterval(t); this.keepaliveTimers.delete(conversationId); }
  }
}
