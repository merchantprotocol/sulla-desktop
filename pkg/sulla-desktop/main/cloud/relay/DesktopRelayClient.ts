// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DesktopRelayInboundMessageRouter } from '@pkg/main/cloud/session/DesktopRelayInboundMessageRouter';

import { DesktopRelayAgentBridge } from './DesktopRelayAgentBridge';
import { DesktopRelayConversationOutbox } from './DesktopRelayConversationOutbox';
import type { DesktopRelayPortSet, DesktopRelayStatus, RelayFrameSink, RelayIncomingFrame } from './DesktopRelayPorts';
import { DesktopRelayRequestHandlers } from './DesktopRelayRequestHandlers';
import { DesktopRelayRuntimePorts } from './DesktopRelayRuntimePorts';
import { DesktopRelayShareServer } from './DesktopRelayShareServer';
import { DesktopRelayTerminalDelivery } from './DesktopRelayTerminalDelivery';
import { DesktopRelayTransport } from './DesktopRelayTransport';
import { DesktopRelayTurnScribe } from './DesktopRelayTurnScribe';

/**
 * Desktop relay client: connects to the Cloudflare Worker `/relay/:room`
 * WebSocket as role=desktop (room = the paired mobile user's id) and serves
 * chat, companion and share requests from the paired phone and the secure
 * desktop channel. It owns one transport, one conversation outbox, one agent
 * bridge and one inbound router for its whole lifetime.
 *
 * Production code must go through getDesktopRelayClient(); construct it
 * directly only in tests.
 */
export class DesktopRelayClient {
  private readonly transport: DesktopRelayTransport;
  private readonly outbox: DesktopRelayConversationOutbox;
  private readonly shares: DesktopRelayShareServer;
  private readonly handlers: DesktopRelayRequestHandlers;
  private readonly router: DesktopRelayInboundMessageRouter;

  constructor(private readonly ports: DesktopRelayPortSet = new DesktopRelayRuntimePorts().create()) {
    const { log, timers } = ports;
    let terminal: DesktopRelayTerminalDelivery | undefined;
    this.transport = new DesktopRelayTransport(ports.sockets, ports.session, timers, log, {
      message:        (raw, socket, generation) => {
        void this.router.route(raw, socket, generation).catch(() => log.warn('[DesktopRelay] Relay command rejected'));
      },
      socketReleased: (socket, generation) => this.shares.abort(socket, generation),
      sessionReset:   () => this.outbox.reset(),
      scopedReady:    () => terminal?.wake(),
      frameDelivered: () => this.outbox.frameDelivered(),
    });
    this.outbox = new DesktopRelayConversationOutbox(this.transport, timers, log, ports.chat.relayApprovals);
    this.shares = new DesktopRelayShareServer(this.transport, ports.files, timers, log);
    const scribe = new DesktopRelayTurnScribe(ports.history, log);
    const deviceId = () => ports.session.deviceId();
    if (ports.terminal) terminal = new DesktopRelayTerminalDelivery(ports.terminal, ports.chat, this.transport, timers);
    const bridge = new DesktopRelayAgentBridge(ports.agent, this.outbox, scribe, ports.chat, deviceId, log, terminal);
    this.handlers = new DesktopRelayRequestHandlers(this.transport, deviceId, this.outbox, bridge, scribe, ports.agent, ports.chat, log);
    this.router = new DesktopRelayInboundMessageRouter({
      deviceId,
      surfaceSignInCode: payload => ports.signIn.surface(payload),
      connected:         () => this.outbox.peerOnline(),
      error:             (reason) => {
        if (reason === 'peer_offline') { this.outbox.peerOffline(); return }
        log.warn(`[DesktopRelay] Relay error: ${ reason }`);
      },
      companion:        async message => this.handlers.companion(message as RelayIncomingFrame, frame => this.outbox.send(frame)),
      shareFetch:       (message, socket, generation) => this.shares.serve(message as RelayIncomingFrame, socket, generation),
      shareFetchCancel: (message, socket, generation) => this.shares.cancel(message as RelayIncomingFrame, socket, generation),
      scoped:           async(message, socket) => {
        if (!this.transport.canAcceptScoped(socket)) return;
        if (message.type === 'relay_terminal_committed') await terminal?.acknowledge(message as RelayIncomingFrame);
        else if (message.type === 'relay_history_check' || ports.session.sharedRelayEnabled?.() === true) {
          await this.handlers.handleScopedCommand(message as RelayIncomingFrame);
        }
      },
      chat:             message => this.handlers.handleChat(message as RelayIncomingFrame),
      cancel:           message => this.handlers.handleCancel(message as RelayIncomingFrame),
      inject:           message => this.handlers.handleInject(message as RelayIncomingFrame),
      clearSecureRoute: conversationId => this.outbox.clearSecureRoute(conversationId),
      log,
    });
  }

  async start(): Promise<void> {
    const paired = await this.ports.pairing.read();
    // Before the settings database is up, reads come from a fallback file that
    // never holds the pairing. Treat that as "not known yet" so the caller's
    // retry loop tries again, instead of concluding no phone is paired.
    if (!paired && !this.ports.pairing.ready()) throw new Error('Settings database not ready yet');
    if (paired) {
      this.transport.connect(paired);
    } else {
      this.ports.log.log('[DesktopRelay] No paired mobile user — waiting for pairing');
    }
  }

  /** Called by IPC when the user saves a new pairing code. */
  async setPairedUserId(userId: string): Promise<void> {
    const trimmed = userId.trim();
    await this.ports.pairing.save(trimmed);
    this.transport.disconnect();
    if (trimmed) this.transport.connect(trimmed);
    else this.transport.broadcastStatus();
  }

  getStatus(): DesktopRelayStatus {
    return this.transport.getStatus();
  }

  onStatusChange(listener: (s: DesktopRelayStatus) => void): () => void {
    return this.transport.onStatusChange(listener);
  }

  /** powerMonitor 'suspend': mobile sees the desktop go offline right away. */
  handleSuspend(): void {
    this.transport.suspend();
  }

  /** powerMonitor 'resume': reconnect with fresh backoff. */
  handleResume(): void {
    this.transport.resume();
  }

  /** Commands from the secure desktop channel, already verified by secureChannel.ts. */
  handleRemoteCommand(msg: RelayIncomingFrame, reply: RelayFrameSink, respond: RelayFrameSink): Promise<void> {
    return this.handlers.handleRemoteCommand(msg, reply, respond);
  }
}
