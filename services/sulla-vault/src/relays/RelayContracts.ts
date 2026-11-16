// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type NodeWebSocket from 'ws';

import type { BrokerRelaySendRequest } from '../contracts.js';

export type VaultRelayOperation = 'slack.socket-mode' | 'discord.gateway' | 'enterprise.gateway' | 'sulla-cloud.relay';

export interface VaultRelayOpenRequest {
  relayId:     string;
  operation:   VaultRelayOperation;
  /** Plaintext is accepted only inside the vault process and is never emitted or logged. */
  credential:  string;
  /** Decrypted routing metadata accepted only for the typed enterprise relay. */
  gatewayUrl?: string;
  /** Address resolved and SSRF-checked by the authority; TLS still verifies gatewayUrl's hostname. */
  gatewayAddress?: { address: string; family: 4 | 6 };
  /** Authority-built wss URL for the typed Sulla Cloud relay (host is re-checked here). */
  targetUrl?: string;
  abortSignal: AbortSignal;
}

export interface VaultRelayEvent {
  sequence: number;
  type:     string;
  payload:  unknown;
}

export interface VaultRelayHandle {
  relayId:   string;
  expiresAt: number;
}

export interface VaultRelayManager {
  open(request: VaultRelayOpenRequest): Promise<VaultRelayHandle>;
  events(relayId: string, signal: AbortSignal): AsyncIterable<VaultRelayEvent>;
  send(relayId: string, command: BrokerRelaySendRequest): Promise<void>;
  close(relayId: string, reason?: string): void;
  closeAll(reason?: string): void;
}

/** One live relay owned by the manager. */
export interface RelaySession {
  readonly relayId:   string;
  readonly expiresAt: number;
  readonly operation: VaultRelayOperation;
  events(signal: AbortSignal): AsyncIterable<VaultRelayEvent>;
  send(command: BrokerRelaySendRequest): Promise<void>;
  close(reason?: string): void;
}

export type SullaCloudSocketFactory = (url: URL, options: NodeWebSocket.ClientOptions) => NodeWebSocket;
