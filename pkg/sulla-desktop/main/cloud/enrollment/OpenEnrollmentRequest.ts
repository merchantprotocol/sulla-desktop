// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  Bytes, VaultTransportError,
  type EnrollmentConfirmDto, type EnrollmentConfirmResponseDto, type EnrollmentConsumeDto, type EnrollmentDenyDto,
  type EnrollmentRequestCreateDto, type EnrollmentRequestCreatedDto, type EnrollmentRequestListDto, type EnrollmentRespondDto,
  type EnrollmentState, type RandomSource, type VaultEnrollmentPort, type VaultEnrollmentStateResponseDto,
} from '@sulla/domain';

import { EnrollmentRequestKey } from './BrokerEnrollmentKeyAgreement';

/** A request this computer has opened on Cloud and not finished: its id, vault, epoch and key. */
export interface OpenEnrollmentRequest {
  readonly vaultId: string;
  readonly epoch: number;
  readonly created: EnrollmentRequestCreatedDto;
  readonly key: EnrollmentRequestKey;
}

/**
 * Holds the one open request. It is opened at gate time — so an approver sees it while the user is still
 * signing in — and enrolled later; the domain `EnrollmentService` opens and polls in one call, so the
 * request opened here is handed to it through {@link ReservedEnrollmentPort}.
 */
export class EnrollmentRequestSlot {
  private request: OpenEnrollmentRequest | null = null;

  forVault(vaultId: string | undefined): OpenEnrollmentRequest | null {
    return this.request && this.request.vaultId === vaultId ? this.request : null;
  }

  hold(request: OpenEnrollmentRequest): void { this.request = request }

  clear(): void { this.request = null }
}

/** Opens a Cloud enrollment request for a vault once; a 409 (one is already pending) leaves the slot empty. */
export class EnrollmentRequestOpener {
  constructor(
    private readonly transport: Pick<VaultEnrollmentPort, 'createEnrollmentRequest'>,
    private readonly subtle: SubtleCrypto,
    private readonly random: RandomSource,
  ) {}

  async open(slot: EnrollmentRequestSlot, state: EnrollmentState): Promise<void> {
    const vaultId = state.vaultId!;
    if (slot.forVault(vaultId)) return;
    const key = await EnrollmentRequestKey.generate(this.subtle);
    const nonce = Bytes.toBase64Url(this.random.bytes(16));
    try {
      const created = await this.transport.createEnrollmentRequest(vaultId, { publicKey: key.publicKeyBase64Url(), nonce });
      slot.hold({ vaultId, epoch: state.epoch!, created, key });
    } catch (error) {
      if (!(error instanceof VaultTransportError) || error.status !== 409) throw error;
    }
  }
}

/**
 * The enrollment port the domain `EnrollmentService` runs against: "creating" the request returns the one
 * already open for this key (no second POST); every other call goes to Cloud.
 */
export class ReservedEnrollmentPort implements VaultEnrollmentPort {
  constructor(private readonly open: OpenEnrollmentRequest, private readonly cloud: VaultEnrollmentPort) {}

  async createEnrollmentRequest(vaultId: string, request: EnrollmentRequestCreateDto): Promise<EnrollmentRequestCreatedDto> {
    if (vaultId !== this.open.vaultId || request.publicKey !== this.open.key.publicKeyBase64Url()) {
      throw new Error('enrollment request was not opened for this vault and key');
    }
    return this.open.created;
  }

  enrollmentState(): Promise<VaultEnrollmentStateResponseDto> { return this.cloud.enrollmentState() }
  listEnrollmentRequests(vaultId: string): Promise<EnrollmentRequestListDto> { return this.cloud.listEnrollmentRequests(vaultId) }
  respondEnrollmentRequest(vaultId: string, requestId: string, request: EnrollmentRespondDto): Promise<void> { return this.cloud.respondEnrollmentRequest(vaultId, requestId, request) }
  consumeEnrollmentRequest(vaultId: string, requestId: string): Promise<EnrollmentConsumeDto> { return this.cloud.consumeEnrollmentRequest(vaultId, requestId) }
  confirmEnrollmentRequest(vaultId: string, requestId: string, request: EnrollmentConfirmDto): Promise<EnrollmentConfirmResponseDto> { return this.cloud.confirmEnrollmentRequest(vaultId, requestId, request) }
  denyEnrollmentRequest(vaultId: string, requestId: string, request: EnrollmentDenyDto): Promise<void> { return this.cloud.denyEnrollmentRequest(vaultId, requestId, request) }
}
