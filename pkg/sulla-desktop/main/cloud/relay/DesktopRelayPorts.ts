// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/*
 * Shared frame types and the ports the desktop relay classes depend on.
 * Production wiring lives in DesktopRelayRuntimePorts; specs pass fakes so
 * reconnect/backoff, keepalives and share streaming run without real time,
 * sockets, databases or Electron.
 */

import type { RelayFailureKind, RelaySocketLike } from '@pkg/main/cloudRelayTransport';
import type { ChatSelection } from '@pkg/main/chatSelection';
import type { NormalizedMobileTurn } from '@pkg/main/mobileRelayContent';

/** WebSocket readyState values (same numbers as WebSocket and VaultRelaySocket). */
export const RELAY_SOCKET_CONNECTING = 0;
export const RELAY_SOCKET_OPEN = 1;

/** Frames that must survive a reconnect: they are queued and flushed on the next `open`. */
export const DURABLE_RELAY_FRAME_TYPES: readonly string[] = ['done', 'stopped', 'error', 'message', 'card', 'ack'];

export type RelayFrame = Record<string, unknown>;
export type RelayFrameSink = (frame: RelayFrame) => void;

export interface ScopedRelayBinding {
  accountId: string;
  workspaceId: string;
  hostDeviceId: string;
}

export interface ScopedRelayRunBinding extends ScopedRelayBinding {
  viewerId: string;
  viewerKey: string;
}

export interface ScopedRelayTerminal extends ScopedRelayRunBinding {
  thread: string;
  run: string;
  outcome: 'completed' | 'stopped' | 'failed';
}

export interface ScopedRelayTerminalStore {
  commit(status: ScopedRelayTerminal): Promise<boolean>;
  pending(account: string, host: string, after: string): Promise<(ScopedRelayTerminal & { id: string })[]>;
  acknowledge(receipt: { thread: string; run: string; accountId: string; workspaceId: string; hostDeviceId: string; outcome: unknown }): Promise<void>;
}

export interface RelayIncomingFrame {
  type:            string;
  relayScope?: 'v1';
  relayRequest?: string;
  viewerId?: string;
  viewerKey?: string;
  nonce?: string;
  requestId?:      string;
  linkId?:         string;
  path?:           string;
  range?:          string;
  method?:         string;
  params?:         Record<string, unknown>;
  // content is a string, or text/image/document parts when the phone
  // attached files — see mobileRelayContent.ts.
  messages?:       { role: 'user' | 'assistant' | 'system'; content: unknown }[];
  conversationId?: string;
  providerId?:     string;
  modelId?:        string;
  agentId?:        string;
  voiceMode?:      boolean;
  /** Content-free trace id of a spoken turn (`vt_…`), for [VoiceTrace] spans. */
  voiceTurnId?:    string;
  /**
   * When the mobile picks a specific desktop to route to (AI Assistant →
   * Which Desktop), the chat payload carries that device's id. The relay
   * broadcasts to every desktop in the room; desktops whose id doesn't
   * match silently drop the message.
   */
  targetDeviceId?: string;
  accountId?: string;
  workspaceId?: string;
  /**
   * Row id the mobile client already inserted its user turn under (chat and
   * inject frames). Scribing under the SAME id makes the desktop's copy and
   * the mobile's copy the same row after sync, instead of a duplicate pair.
   */
  userMessageId?:  string;
  clientRunId?:    string;
  outcome?:        string;
  role?:           'desktop' | 'mobile';
  reason?:         string;
  code?:           string;
  expiresAt?:      string;
  requestingDeviceId?: string;
  requestingDeviceName?: string;
}

export interface DesktopRelayStatus {
  pairedUserId: string;
  connected:    boolean;
  lastError?:   string;
}

export interface DesktopRelayLog {
  log(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export type RelayTimeout = ReturnType<typeof setTimeout>;
export type RelayInterval = ReturnType<typeof setInterval>;

export interface DesktopRelayTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): RelayTimeout;
  clearTimeout(timer: RelayTimeout): void;
  setInterval(callback: () => void, delayMs: number): RelayInterval;
  clearInterval(timer: RelayInterval): void;
}

/** The vault-owned relay socket surface (VaultRelaySocket) the transport reads after failures. */
export interface VaultRelaySocketView {
  readonly failure:       RelayFailureKind | null;
  readonly failureDetail: string | null;
  takePendingOutbound(): string[];
}

export interface DesktopRelaySocketPorts {
  /** True when the container vault owns the Sulla Cloud session and opens relay sockets itself. */
  usesVault(): boolean;
  openVault(room: string, deviceId: string): RelaySocketLike;
  /** Never log this URL: it carries the token. */
  openNative(url: string): RelaySocketLike;
  /** The vault view of a socket, or null for a plain WebSocket. */
  vaultView(socket: RelaySocketLike): VaultRelaySocketView | null;
}

export interface DesktopRelaySessionPorts {
  sharedRelayEnabled?(): boolean;
  proveRelayDevice?(room: string, deviceId: string, nonce: string): Promise<string>;
  accessToken(): Promise<string | null | undefined>;
  deviceId(): Promise<string>;
  acquireLiveness(holder: string): void;
  releaseLiveness(holder: string): void;
}

export interface DesktopRelayPairingStore {
  read(): Promise<string>;
  /** False while settings reads come from the boot-time fallback file. */
  ready(): boolean;
  save(userId: string): Promise<void>;
}

/** The local agent WebSocket channel mobile turns are bridged onto. */
export interface DesktopRelayAgentChannel {
  connect(channel: string): void;
  send(channel: string, message: Record<string, unknown>): void;
  onMessage(channel: string, handler: (message: { type: string; data?: unknown }) => unknown): void;
}

export interface DesktopRelayHistoryPorts {
  scribe(turn: { conversationId: string; role: 'user' | 'assistant' | 'tool'; content: string; ts: string; id?: string }): Promise<void>;
  acceptUserTurn(turn: { conversationId: string; role: 'user'; content: string; ts: string; id: string; scope?: ScopedRelayBinding }): Promise<'accepted' | 'duplicate' | 'conflict'>;
  deriveMessageId(conversationId: string, role: string, content: string, ts: string): string;
}

export interface DesktopRelayChatPorts {
  currentRelayAccount?(): Promise<string>;
  allowScopedHistory?(): Promise<boolean>;
  approveViewer?(id: string, key: string): Promise<boolean>;
  modelCapabilities?(): Promise<readonly { providerId: string; modelId: string }[]>;
  relayApprovals?(): readonly (readonly [string, string])[];
  admitRelayThread?(thread: string, existing: boolean, scope?: ScopedRelayBinding): Promise<boolean>;
  validateSelection(message: RelayIncomingFrame): Promise<ChatSelection>;
  persistAttachments(conversationId: string, messageId: string, turn: NormalizedMobileTurn): Promise<string[]>;
  companionRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
  registerMobileCard(threadId: string, kind: string, data: unknown): Promise<void>;
}

export interface DesktopRelayFilesPorts {
  serviceToken(): Promise<string | null | undefined>;
  fetch(url: URL, init: RequestInit): Promise<Response>;
  origin(): string;
}

export interface DesktopRelaySignInNotifier {
  surface(payload: { requestId: string; code: string; expiresAt: string; requestingDeviceId: string; requestingDeviceName: string }): void;
}

export interface DesktopRelayPortSet {
  log:       DesktopRelayLog;
  timers:    DesktopRelayTimers;
  sockets:   DesktopRelaySocketPorts;
  session:   DesktopRelaySessionPorts;
  pairing:   DesktopRelayPairingStore;
  agent:     () => DesktopRelayAgentChannel;
  history:   DesktopRelayHistoryPorts;
  terminal?: ScopedRelayTerminalStore;
  chat:      DesktopRelayChatPorts;
  files:     DesktopRelayFilesPorts;
  signIn:    DesktopRelaySignInNotifier;
}
