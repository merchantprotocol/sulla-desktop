// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  EnrollmentService, EnrollmentState,
  type EnrollmentPollingConfig, type EnrollmentSleeper, type RandomSource,
} from '@sulla/domain';
import type { Clock } from '@sulla/foundation';

import { BrokerAdoptionKeyAgreement, type VaultEnrollmentBrokerSource } from './BrokerEnrollmentKeyAgreement';
import type { CloudEnrollmentTransport, EnrollmentUserSource } from './CloudEnrollmentTransport';
import { EnrollmentRequestSlot, ReservedEnrollmentPort, type EnrollmentRequestOpener } from './OpenEnrollmentRequest';

export type EnrollmentDisposition = 'create' | 'trusted' | 'adopted' | 'approval_available' | 'waiting_for_approver' | 'recovery';

/** Tells the rest of Desktop the local vault is now unlocked. */
export interface VaultUnlockNotifier {
  vaultUnlocked(): Promise<void>;
}

export interface DesktopEnrollmentDependencies {
  readonly session: EnrollmentUserSource;
  readonly transport: CloudEnrollmentTransport;
  readonly opener: EnrollmentRequestOpener;
  readonly broker: VaultEnrollmentBrokerSource;
  readonly unlock: VaultUnlockNotifier;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly polling: EnrollmentPollingConfig;
  readonly sleeper?: EnrollmentSleeper;
}

/**
 * Desktop's side of joining an existing Cloud vault (the requester). `gate()` asks Cloud whether a vault
 * exists before any local-vault create path runs, and opens the enrollment request early so an approver
 * can see it; `complete()` runs the domain `EnrollmentService` (sleep-first 60 x 5 s poll, consume, confirm)
 * on that request, then commits the staged vault in the container. Key custody: see BrokerEnrollmentKeyAgreement.
 */
export class DesktopEnrollmentCoordinator {
  static readonly POLLING: EnrollmentPollingConfig = { intervalMs: 5_000, maxAttempts: 60 };

  private pending: Promise<EnrollmentDisposition> | null = null;
  private prepared: Promise<EnrollmentState> | null = null;
  private preparedForUserId = '';
  private readonly slot = new EnrollmentRequestSlot();

  constructor(private readonly deps: DesktopEnrollmentDependencies) {}

  /** Ask Cloud about the signed-in account before any local-vault create path runs. */
  async gate(): Promise<EnrollmentDisposition> {
    const userId = await this.deps.session.userId();
    if (!userId) throw new Error('enrollment_requires_cloud_session');
    if (this.preparedForUserId !== userId) {
      this.preparedForUserId = userId;
      this.prepared = null;
      this.slot.clear();
    }
    // Never cache a failure: a lookup made before the vault broker or network
    // is answering would otherwise fail every later retry for the whole run
    // (seen on a fresh iMac first run: vault creation refused for minutes).
    if (!this.prepared) {
      const lookup = this.lookup();
      this.prepared = lookup;
      lookup.catch(() => { if (this.prepared === lookup) this.prepared = null });
    }
    return this.disposition(await this.prepared);
  }

  /** Enroll with the account master key; concurrent callers share one run. */
  complete(masterKey: Uint8Array, cloudUserId: string): Promise<EnrollmentDisposition> {
    this.pending ??= this.run(masterKey, cloudUserId).finally(() => { this.pending = null });
    return this.pending;
  }

  private async run(masterKey: Uint8Array, cloudUserId: string): Promise<EnrollmentDisposition> {
    const disposition = await this.gate();
    if (disposition !== 'approval_available' && disposition !== 'waiting_for_approver') return disposition;
    return this.enroll(await this.prepared!, masterKey, cloudUserId);
  }

  private async lookup(): Promise<EnrollmentState> {
    const state = EnrollmentState.fromDto(await this.deps.transport.enrollmentState());
    if (state.requiresApproval()) await this.deps.opener.open(this.slot, state);
    return state;
  }

  private disposition(state: EnrollmentState): EnrollmentDisposition {
    if (state.value === 'no_vault') return 'create';
    if (state.value === 'trusted') return 'trusted';
    if (state.value === 'recovery_required') return 'recovery';
    return state.value;
  }

  private async enroll(state: EnrollmentState, masterKey: Uint8Array, cloudUserId: string): Promise<EnrollmentDisposition> {
    await this.deps.opener.open(this.slot, state);
    const open = this.slot.forVault(state.vaultId);
    if (!open) return state.value === 'approval_available' ? 'approval_available' : 'waiting_for_approver';
    const service = new EnrollmentService(
      new ReservedEnrollmentPort(open, this.deps.transport.forUser(cloudUserId)),
      new BrokerAdoptionKeyAgreement(open.key, { masterKey, cloudUserId }, this.deps.broker),
      this.deps.clock,
      this.deps.polling,
      this.deps.random,
      this.deps.sleeper,
    );
    const result = await service.enroll(open.vaultId, open.epoch);
    await this.deps.broker.require().commitVaultEnrollment(result.requestId);
    await this.deps.unlock.vaultUnlocked();
    this.slot.clear();
    return 'adopted';
  }
}
