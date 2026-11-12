// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  VaultTransportError,
  type EnrollmentConfirmDto, type EnrollmentConfirmResponseDto, type EnrollmentConsumeDto, type EnrollmentDenyDto,
  type EnrollmentRequestCreateDto, type EnrollmentRequestCreatedDto, type EnrollmentRequestListDto, type EnrollmentRespondDto,
  type VaultEnrollmentPort, type VaultEnrollmentStateResponseDto, type VaultErrorCode,
} from '@sulla/domain';

import {
  JsonRequestBody, VaultSyncHttpError,
  type CloudVaultSyncHttpTransport, type VaultBundleResponse, type VaultRecordsResponse, type VaultStatus,
} from '../vaultSyncV3/transport';
import type { VaultSyncRequestSigner } from './VaultSyncRequestSigner';

/** Who the signed calls speak for: the signed-in Cloud user, or a fixed user for one enrollment. */
export interface EnrollmentUserSource {
  userId(): Promise<string>;
}

export class FixedEnrollmentUser implements EnrollmentUserSource {
  constructor(private readonly id: string) {}
  async userId(): Promise<string> { return this.id }
}

/**
 * Desktop's HTTP adapter for the domain `VaultEnrollmentPort` (the domain ships none). It owns the Cloud
 * wire contract (sulla-workers `src/routes/cloud-vault-sync.ts`): op strings, one serialisation per body
 * (the signed hash covers the bytes sent), the device signature on every call, and error mapping:
 * - consume: ANY 409 means "not approved yet", mapped to the domain pending code so polling continues;
 * - every other HTTP error becomes `VaultTransportError(code, status)` with the same message code as before.
 * Status, bundle and records are plain passthroughs the approver needs.
 */
export class CloudEnrollmentTransport implements VaultEnrollmentPort {
  constructor(
    private readonly http: CloudVaultSyncHttpTransport,
    private readonly signer: VaultSyncRequestSigner,
    private readonly user: EnrollmentUserSource,
  ) {}

  /** The same transport, signing as `userId` (the Cloud user an enrollment was started for). */
  forUser(userId: string): CloudEnrollmentTransport {
    return new CloudEnrollmentTransport(this.http, this.signer, new FixedEnrollmentUser(userId));
  }

  async status(): Promise<VaultStatus> {
    return this.call(async() => this.http.getStatus(await this.signer.deviceId()));
  }

  async enrollmentState(): Promise<VaultEnrollmentStateResponseDto> {
    const status = await this.status();
    if (!status.enabled || !status.vaultId) return { state: 'no_vault' };
    const vaultId = status.vaultId;
    return this.call(async() => this.http.getEnrollmentState(vaultId, await this.sign(vaultId, 'enrollment-state')));
  }

  async listEnrollmentRequests(vaultId: string): Promise<EnrollmentRequestListDto> {
    const listed = await this.call(async() => this.http.listEnrollmentRequests(vaultId, await this.sign(vaultId, 'enrollment-list')));
    // Cloud lists requests without their vault; the domain request carries it.
    return { requests: (listed.requests ?? []).map(request => ({ ...request, vaultId })) } as EnrollmentRequestListDto;
  }

  async createEnrollmentRequest(vaultId: string, request: EnrollmentRequestCreateDto): Promise<EnrollmentRequestCreatedDto> {
    const body = new JsonRequestBody({ publicKey: request.publicKey, nonce: request.nonce });
    return this.call(async() => this.http.openEnrollmentRequest(vaultId, body, await this.sign(vaultId, 'enrollment-request', body)));
  }

  async consumeEnrollmentRequest(vaultId: string, requestId: string): Promise<EnrollmentConsumeDto> {
    const body = new JsonRequestBody({});
    try {
      return await this.call(async() => this.http.consumeEnrollmentRequest(vaultId, requestId, body, await this.sign(vaultId, `enrollment-consume:${ requestId }`, body))) as EnrollmentConsumeDto;
    } catch (error) {
      if (error instanceof VaultTransportError && error.status === 409) throw new VaultTransportError('request_not_found_or_consumed', 409, { cause: error });
      throw error;
    }
  }

  async confirmEnrollmentRequest(vaultId: string, requestId: string, request: EnrollmentConfirmDto): Promise<EnrollmentConfirmResponseDto> {
    const body = new JsonRequestBody({ bundleMac: request.bundleMac, headMac: request.headMac });
    return this.call(async() => this.http.confirmEnrollmentRequest(vaultId, requestId, body, await this.sign(vaultId, `enrollment-confirm:${ requestId }`, body))) as Promise<EnrollmentConfirmResponseDto>;
  }

  async respondEnrollmentRequest(vaultId: string, requestId: string, request: EnrollmentRespondDto): Promise<void> {
    const body = new JsonRequestBody({ wrappedUserKey: request.wrappedUserKey });
    await this.call(async() => this.http.respondToEnrollmentRequest(vaultId, requestId, body, await this.sign(vaultId, `enrollment-respond:${ requestId }`, body)));
  }

  /**
   * sulla-workers has no enrollment deny route (re-checked on main 3e7f8cf, 2026-11-12), so a declined prompt sends
   * nothing and the request expires on Cloud. Desktop never calls this.
   */
  async denyEnrollmentRequest(_vaultId: string, _requestId: string, _request: EnrollmentDenyDto): Promise<void> {
    throw new VaultTransportError('enrollment_deny_unsupported' as VaultErrorCode, 501);
  }

  async bundle(vaultId: string): Promise<VaultBundleResponse> {
    return this.call(async() => this.http.getBundle(vaultId, await this.signer.deviceId()));
  }

  async records(vaultId: string): Promise<VaultRecordsResponse> {
    return this.call(async() => this.http.getRecords(vaultId, await this.signer.deviceId()));
  }

  private async sign(vaultId: string, operation: string, body?: JsonRequestBody) {
    return this.signer.sign(await this.user.userId(), vaultId, operation, body?.bytes);
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof VaultSyncHttpError) throw new VaultTransportError(error.code as VaultErrorCode, error.status, { cause: error });
      throw error;
    }
  }
}
