// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { ReceiverRunGuard } from './ReceiverRunGuard';

export type AgentMessageKind = 'human' | 'parent' | 'child' | 'peer' | 'contract' | 'blocker';
export type AgentInboxDeliveryReceipt = 'accepted' | 'deferred' | 'failed';
export interface AgentMessageEnvelope { from: string; kind: AgentMessageKind; body: string; ids: { messageId: string; jobId?: string; taskIndex?: number; threadId?: string } }
export interface AgentInboxTarget { channel: string; threadId?: string; agentId?: string }
export interface AgentInboxEntry { envelope: AgentMessageEnvelope; target: AgentInboxTarget }
export interface AgentInboxClaim { owner: string; target: AgentInboxTarget; entries: AgentInboxEntry[] }
export interface AgentInboxRepository {
  enqueue(entry: AgentInboxEntry): Promise<boolean>;
  claim(target: AgentInboxTarget, owner: string): Promise<AgentInboxClaim>;
  renew(claim: AgentInboxClaim): Promise<void>;
  acknowledge(claim: AgentInboxClaim): Promise<void>;
  release(claim: AgentInboxClaim): Promise<void>;
  pendingTargets(): Promise<AgentInboxTarget[]>;
}
export interface AgentInboxDeliveryPolicy {
  isRunning(target: AgentInboxTarget): boolean;
  wake(target: AgentInboxTarget, batch: string, entries: AgentInboxEntry[]): Promise<AgentInboxDeliveryReceipt>;
}
export interface AgentInboxScheduler { schedule(callback: () => void): void }

class ImmediateAgentInboxScheduler implements AgentInboxScheduler {
  schedule(callback: () => void): void { setImmediate(callback); }
}

/** Durable, leased, deduplicated mailbox. It never interrupts an active receiver. */
export class AgentInbox {
  constructor(
    private readonly repository: AgentInboxRepository,
    private readonly delivery: AgentInboxDeliveryPolicy,
    private readonly runGuard = new ReceiverRunGuard(),
    private readonly maxDrainTurns = 8,
    private readonly leaseRenewIntervalMs = 30_000,
    private readonly scheduler: AgentInboxScheduler = new ImmediateAgentInboxScheduler(),
  ) {}

  async receive(entry: AgentInboxEntry): Promise<'duplicate' | 'queued' | 'delivered'> {
    const inserted = await this.repository.enqueue(entry);
    if (!inserted) return 'duplicate';
    if (this.delivery.isRunning(entry.target)) return 'queued';
    return await this.flush(entry.target) > 0 ? 'delivered' : 'queued';
  }

  /** Claims across processes and rechecks after each accepted turn so late arrivals cannot strand. */
  async flush(target: AgentInboxTarget): Promise<number> {
    // This synchronous reservation closes the gap before the first repository
    // await: replay, recovery and live arrivals cannot start competing turns.
    const reservation = this.runGuard.tryReserve(target);
    if (!reservation) return 0;
    let delivered = 0;
    let hitCap = false;
    try {
      for (let turn = 0; turn < this.maxDrainTurns; turn++) {
        const claim = await this.repository.claim(target, randomUUID());
        if (!claim.entries.length) break;
        let receipt: AgentInboxDeliveryReceipt = 'failed';
        let renewalFailure: unknown;
        let renewal = Promise.resolve();
        const renew = () => {
          renewal = renewal.then(() => this.repository.renew(claim)).catch(error => { renewalFailure ??= error; });
        };
        const renewalTimer = setInterval(renew, this.leaseRenewIntervalMs);
        renewalTimer.unref?.();
        try {
          receipt = await this.delivery.wake(target, this.render(claim.entries), claim.entries);
          clearInterval(renewalTimer);
          await renewal;
          if (renewalFailure) throw renewalFailure;
          if (receipt === 'accepted') {
            await this.repository.acknowledge(claim);
            delivered += claim.entries.length;
            hitCap = turn + 1 === this.maxDrainTurns;
          } else await this.repository.release(claim);
        } catch (error) {
          clearInterval(renewalTimer);
          await renewal.catch(() => undefined);
          await this.repository.release(claim);
          throw error;
        }
        if (receipt !== 'accepted') break;
      }
      return delivered;
    } finally {
      reservation.release();
      if (hitCap) {
        try {
          const pendingTargets = await this.repository.pendingTargets();
          if (pendingTargets.some(pending => this.isSameTarget(pending, target))) {
            this.scheduler.schedule(() => { void this.flush(target); });
          }
        } catch {
          // Preserve the original delivery or repository error.
        }
      }
    }
  }

  private isSameTarget(left: AgentInboxTarget, right: AgentInboxTarget): boolean {
    return left.channel === right.channel && left.threadId === right.threadId;
  }

  async replayPending(): Promise<number> {
    let delivered = 0;
    for (const target of await this.repository.pendingTargets()) if (!this.delivery.isRunning(target)) delivered += await this.flush(target);
    return delivered;
  }

  render(entries: AgentInboxEntry[]): string {
    return entries.map(({ envelope }) => {
      const label = envelope.kind === 'peer' ? `Peer message from ${ envelope.from }` : `${ envelope.kind } message from ${ envelope.from }`;
      return `[${ label }]\n${ envelope.body }`;
    }).join('\n\n==========\n\n');
  }
}
