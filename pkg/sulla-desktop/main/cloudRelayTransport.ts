// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Vault-brokered transport for the Sulla Cloud mobile relay.
 *
 * With the container-hosted vault the app never holds the sulla-cloud session
 * token. The vault opens the relay WebSocket itself (`sulla-cloud.relay`):
 * it refreshes the access token, authenticates the handshake, and hands back
 * only an opaque relay id plus the relay's text frames. This class exposes
 * that session through the small WebSocket surface DesktopRelayClient uses.
 */

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import {
  issueLocalBrokerContext,
  requireConfiguredCredentialBroker,
  usesContainerVaultAuthority,
  VaultBrokerError,
} from '@pkg/vault-broker';
import type { LocalVaultBrokerClient, ToolExecutionContext } from '@pkg/vault-broker';

export const SULLA_CLOUD_INTEGRATION_ID = 'sulla-cloud';
export const SULLA_CLOUD_RELAY_OPERATION = 'sulla-cloud.relay';

/** The minimal WebSocket surface DesktopRelayClient depends on. */
export interface RelaySocketLike {
  readonly readyState:     number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

/** Why a vault relay session is not (or no longer) connected; drives backoff. */
export type RelayFailureKind = 'vault_locked' | 'signed_out' | 'denied' | 'unavailable';

export interface VaultRelayDeps {
  broker:       () => Pick<LocalVaultBrokerClient, 'status' | 'createRelay' | 'relayEventStream' | 'relaySend' | 'closeRelay'>;
  issueContext: (accountId: string, signal: AbortSignal) => Promise<ToolExecutionContext>;
  /** Metadata only: account ids/labels, never values. */
  listAccounts: () => Promise<{ account_id: string; active: boolean; connected: boolean }[]>;
}

export function cloudRelayUsesVault(): boolean {
  return usesContainerVaultAuthority();
}

const defaultDeps: VaultRelayDeps = {
  broker:       () => requireConfiguredCredentialBroker(),
  issueContext: (accountId, signal) => issueLocalBrokerContext({
    agentId:         'sulla',
    podId:           'desktop-relay',
    credentialScope: { integration_id: SULLA_CLOUD_INTEGRATION_ID, account_id: accountId },
    signal,
  }),
  listAccounts: () => getIntegrationService().getAccounts(SULLA_CLOUD_INTEGRATION_ID),
};

export function classifyRelayFailure(error: unknown): RelayFailureKind {
  if (error instanceof VaultRelaySetupError) return error.kind;
  if (error instanceof VaultBrokerError) {
    if (error.code === 'vault_locked' || error.status === 423) return 'vault_locked';
    if (error.status === 401 || error.code === 'credential_field_missing') return 'signed_out';
    if (error.status === 403 || error.status === 428 || ['policy_denied', 'destination_denied', 'approval_required'].includes(error.code)) {
      return 'denied';
    }
  }
  return 'unavailable';
}

class VaultRelaySetupError extends Error {
  constructor(readonly kind: RelayFailureKind, message: string) {
    super(message);
  }
}

export class VaultRelaySocket implements RelaySocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = VaultRelaySocket.CONNECTING;
  bufferedAmount = 0;
  /** Set when the session fails; read by the relay client to pick a backoff. */
  failure: RelayFailureKind | null = null;
  /** Sanitized upstream detail (HTTP status or WebSocket close code). */
  failureDetail: string | null = null;

  private relayId:           string | null = null;
  private readonly abort = new AbortController();
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly outbound: string[] = [];
  private pumping = false;
  private closeEmitted = false;

  constructor(
    private readonly room: string,
    private readonly deviceId: string,
    private readonly deps: VaultRelayDeps = defaultDeps,
  ) {
    // Like a browser WebSocket, connection starts after listeners attach.
    Promise.resolve().then(() => this.run()).catch(() => undefined);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    if (this.readyState !== VaultRelaySocket.OPEN) throw new Error('Relay socket is not open');
    this.outbound.push(data);
    this.bufferedAmount += Buffer.byteLength(data);
    this.pump().catch(() => undefined);
  }

  close(): void {
    if (this.readyState === VaultRelaySocket.CLOSED) return;
    this.readyState = VaultRelaySocket.CLOSED;
    this.abort.abort();
    const relayId = this.relayId;
    this.relayId = null;
    if (relayId) {
      try {
        this.deps.broker().closeRelay(relayId).catch(() => undefined);
      } catch { /* broker gone; session expires in the vault */ }
    }
    Promise.resolve().then(() => this.emitClose()).catch(() => undefined);
  }

  /**
   * Return frames the vault had not accepted before this socket failed.
   * Desktop can move critical frames to its reconnect queue instead of losing
   * them when the opaque vault transport fails asynchronously after send().
   */
  takePendingOutbound(): string[] {
    const pending = this.outbound.splice(0);
    this.bufferedAmount = 0;
    return pending;
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    try {
      const broker = this.deps.broker();
      const status = await broker.status(signal);
      if (!status.unlocked) throw new VaultRelaySetupError('vault_locked', 'Vault is locked');
      const accounts = await this.deps.listAccounts();
      const account = accounts.find(entry => entry.account_id === this.room) ??
        accounts.find(entry => entry.active) ?? accounts[0];
      if (!account) throw new VaultRelaySetupError('signed_out', 'No Sulla Cloud account in the vault');
      const context = await this.deps.issueContext(account.account_id, signal);
      if (signal.aborted) return;
      const relay = await broker.createRelay(
        context,
        SULLA_CLOUD_RELAY_OPERATION,
        { integrationId: SULLA_CLOUD_INTEGRATION_ID, accountId: account.account_id },
        signal,
        undefined,
        { room: this.room, deviceId: this.deviceId },
      );
      if (signal.aborted) {
        broker.closeRelay(relay.relayId).catch(() => undefined);
        return;
      }
      this.relayId = relay.relayId;
      this.readyState = VaultRelaySocket.OPEN;
      this.emit('open', {});
      for await (const event of broker.relayEventStream(relay.relayId, signal)) {
        if (signal.aborted) break;
        if (event.type === 'sulla-cloud.frame') {
          const data = (event.payload as { data?: unknown } | null)?.data;
          if (typeof data === 'string') this.emit('message', { data });
          continue;
        }
        if (event.type === 'relay.closed') {
          const code = Number((event.payload as { code?: unknown } | null)?.code);
          this.failureDetail = Number.isSafeInteger(code) ? `WebSocket close code ${ code }` : 'WebSocket closed';
          break;
        }
        if (event.type === 'relay.gap' || event.type === 'relay.error') {
          this.failureDetail = event.type;
          break;
        }
      }
      if (!signal.aborted) this.fail('unavailable', this.failureDetail ?? 'Relay session ended');
    } catch (error) {
      if (signal.aborted) return;
      const status = error instanceof VaultBrokerError ? error.status : undefined;
      const message = error instanceof Error ? error.message : 'Relay session failed';
      this.failureDetail = status ? `HTTP ${ status }: ${ message }` : message;
      this.fail(classifyRelayFailure(error), this.failureDetail);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.outbound.length && this.readyState === VaultRelaySocket.OPEN && this.relayId) {
        const frame = this.outbound[0];
        await this.deps.broker().relaySend(this.relayId, { type: 'sulla-cloud.frame', payload: { data: frame } }, this.abort.signal);
        this.outbound.shift();
        this.bufferedAmount = Math.max(0, this.bufferedAmount - Buffer.byteLength(frame));
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        const status = error instanceof VaultBrokerError ? error.status : undefined;
        const message = error instanceof Error ? error.message : 'Relay send failed';
        this.failureDetail = status ? `HTTP ${ status }: ${ message }` : message;
        this.fail(classifyRelayFailure(error), this.failureDetail);
      }
    } finally {
      this.pumping = false;
    }
  }

  private fail(kind: RelayFailureKind, message: string): void {
    if (this.readyState === VaultRelaySocket.CLOSED) return;
    this.failure = kind;
    this.emit('error', { message });
    this.close();
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close', {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      try { listener(event) } catch { /* listener errors must not break the session */ }
    }
  }
}
