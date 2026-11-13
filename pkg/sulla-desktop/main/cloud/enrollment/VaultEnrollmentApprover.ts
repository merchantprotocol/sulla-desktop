// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DeviceApprovalService, type ApprovalPayload, type HumanApprovalGate } from '@sulla/domain';

import { BrokerWrapKeyAgreement, type VaultEnrollmentBrokerSource } from './BrokerEnrollmentKeyAgreement';
import type { CloudEnrollmentTransport } from './CloudEnrollmentTransport';

/**
 * The approver side of vault enrollment for one poll: list this vault's pending requests and offer each
 * unseen one to a human through the domain `DeviceApprovalService` (gate first; nothing reaches Cloud or the
 * vault without the tap). At most one request is approved per poll. A declined request is only marked seen:
 * sulla-workers has no deny route, so it expires on Cloud.
 */
export class VaultEnrollmentApprover {
  /** The container holds the user key and reads its own bundle/records; the domain arguments are unused. */
  private static readonly KEY_IN_CONTAINER = new Uint8Array(0);
  private static readonly PAYLOAD_IN_CONTAINER: ApprovalPayload = { bundle: {}, head: {} };

  constructor(
    private readonly transport: CloudEnrollmentTransport,
    private readonly gate: HumanApprovalGate,
    private readonly broker: VaultEnrollmentBrokerSource,
  ) {}

  async poll(seen: Set<string>): Promise<void> {
    const status = await this.transport.status();
    if (!status.enabled || !status.vaultId) return;
    const { requests } = await this.transport.listEnrollmentRequests(status.vaultId);
    for (const request of requests) {
      if (seen.has(`enroll:${ request.id }`)) continue;
      seen.add(`enroll:${ request.id }`);
      const approval = new DeviceApprovalService(this.transport, new BrokerWrapKeyAgreement(request.publicKey, status.epoch, this.transport, this.broker), this.gate);
      if (!await approval.approve(request, Number(status.epoch), VaultEnrollmentApprover.KEY_IN_CONTAINER, VaultEnrollmentApprover.PAYLOAD_IN_CONTAINER)) continue;
      break;
    }
  }
}
