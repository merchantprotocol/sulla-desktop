// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.


import type { DesktopRelayChatPorts, DesktopRelayTimers, RelayIncomingFrame, RelayTimeout, ScopedRelayTerminal, ScopedRelayTerminalStore } from './DesktopRelayPorts';
import type { DesktopRelayTransport } from './DesktopRelayTransport';

const RETRY_MS = 15_000;

/** Status-only outbox. The committed local row is the source of retries until
 * the verified relay confirms the exact Cloud commit. Nothing dispatches here. */
export class DesktopRelayTerminalDelivery {
  private readonly uncommitted = new Map<string, ScopedRelayTerminal>();
  private timer?: RelayTimeout;
  private draining = false;
  private after = '';
  private scope = '';

  constructor(
    private readonly store: ScopedRelayTerminalStore,
    private readonly chat: Pick<DesktopRelayChatPorts, 'currentRelayAccount' | 'approveViewer' | 'allowScopedHistory' | 'admitRelayThread'>,
    private readonly transport: DesktopRelayTransport,
    private readonly timers: DesktopRelayTimers,
  ) {}

  async record(status: ScopedRelayTerminal): Promise<boolean> {
    const key = JSON.stringify([status.accountId, status.workspaceId, status.hostDeviceId, status.thread, status.run]);
    // Until any durable write succeeds the pending observation can only exist
    // in this process. Do not claim local or Cloud success in that interval.
    let committed = false;
    try {
      committed = await this.store.commit(status);
      this.uncommitted.delete(key);
    } catch { this.uncommitted.set(key, status) }
    this.wake();
    return committed;
  }

  wake(): void {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.after = '';
    void this.drain();
  }

  async acknowledge(frame: RelayIncomingFrame): Promise<void> {
    if (typeof frame.conversationId !== 'string' || typeof frame.clientRunId !== 'string'
        || typeof frame.accountId !== 'string' || typeof frame.workspaceId !== 'string'
        || frame.accountId !== await this.chat.currentRelayAccount?.()) return;
    await this.store.acknowledge({ thread: frame.conversationId, run: frame.clientRunId, accountId: frame.accountId,
      workspaceId: frame.workspaceId, hostDeviceId: this.transport.deviceId, outcome: frame.outcome });
  }

  private async permitted(status: ScopedRelayTerminal): Promise<boolean> {
    try {
      return await this.chat.admitRelayThread?.(status.thread, true, status) === true
        && await this.chat.allowScopedHistory?.() === true
        && await this.chat.approveViewer?.(status.viewerId, status.viewerKey) === true
        && await this.chat.currentRelayAccount?.() === status.accountId;
    } catch { return false }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const [key, status] of this.uncommitted) {
        if (await this.chat.currentRelayAccount?.() !== status.accountId) continue;
        await this.store.commit(status);
        this.uncommitted.delete(key);
      }
      if (!this.transport.isScopedReady) return;
      const account = await this.chat.currentRelayAccount?.();
      const host = this.transport.deviceId;
      if (!account || !host) return;
      const scope = JSON.stringify([account, host]);
      if (scope !== this.scope) { this.scope = scope; this.after = '' }
      const pending = await this.store.pending(account, host, this.after);
      this.after = pending.at(-1)?.id ?? '';
      for (const status of pending) {
        if (this.transport.deviceId !== status.hostDeviceId || !await this.permitted(status)) continue;
        this.transport.send({ type: 'relay_terminal', relayScope: 'v1', conversationId: status.thread,
          clientRunId: status.run, outcome: status.outcome, accountId: status.accountId, workspaceId: status.workspaceId,
          viewerId: status.viewerId, viewerKey: status.viewerKey }, 'relay_terminal');
      }
    } catch { /* durable pending rows remain retryable, without logging their contents */ } finally {
      this.draining = false;
      if (this.uncommitted.size || this.transport.isScopedReady) {
        this.timer = this.timers.setTimeout(() => { this.timer = undefined; void this.drain() }, RETRY_MS);
      }
    }
  }
}
