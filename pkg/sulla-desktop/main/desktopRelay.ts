// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

import { DesktopRelayClient } from '@pkg/main/cloud/relay/DesktopRelayClient';
import { DesktopRelayServiceProvider } from '@pkg/main/cloud/relay/DesktopRelayServiceProvider';

// The implementation lives in main/cloud/relay/: DesktopRelayTransport (socket,
// backoff, heartbeat, suspend/resume, durable queue), DesktopRelayConversationOutbox
// (run stamping, secure routes, keepalives), DesktopRelayRequestHandlers (chat,
// inject, cancel, companion), DesktopRelayAgentBridge (agent channel → mobile
// frames), DesktopRelayShareServer (Files shares with backpressure) and
// DesktopRelayClient, which wires them together.

// Exported for tests only — production code must go through getDesktopRelayClient().
export { DesktopRelayClient, DesktopRelayServiceProvider };

// Main-process service-provider binding. Relay state belongs to the client instance, never a module-level object graph.
export const desktopRelayProvider = new DesktopRelayServiceProvider(new DesktopRelayClient());

/** Compatibility exports retained for current main-process callers. */
export function getDesktopRelayClient(): DesktopRelayClient {
  return desktopRelayProvider.getClient();
}

export function initDesktopRelayEvents(): void {
  desktopRelayProvider.registerEvents();
}
