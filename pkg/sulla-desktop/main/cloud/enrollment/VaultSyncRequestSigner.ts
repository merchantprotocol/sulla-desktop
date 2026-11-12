// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DeviceSignaturePayload, type CryptoPrimitives, type DeviceIdentityService } from '@sulla/domain';
import type { Clock } from '@sulla/foundation';

import type { VaultSyncSignature } from '../vaultSyncV3/transport';

/**
 * Signs one vault-sync-v3 Cloud call: `sulla-vault-sync-v3 / user / device / vault / op / sha256(body) / ts`
 * (domain `DeviceSignaturePayload`), with the timestamp in unix SECONDS — sulla-workers rejects milliseconds —
 * and the same value is what the caller sends as `X-Sulla-Timestamp`. `body` must be the exact bytes sent
 * (empty for a GET).
 */
export class VaultSyncRequestSigner {
  private static readonly PURPOSE = 'vault-sync-v3' as const;
  private readonly payload: DeviceSignaturePayload;

  constructor(
    private readonly identity: Pick<DeviceIdentityService, 'deviceId' | 'signerFor'>,
    crypto: Pick<CryptoPrimitives, 'sha256'>,
    private readonly clock: Clock,
  ) {
    this.payload = new DeviceSignaturePayload(crypto);
  }

  async deviceId(): Promise<string> {
    return (await this.identity.deviceId()).value;
  }

  async sign(userId: string, vaultId: string, operation: string, body: Uint8Array = new Uint8Array(0)): Promise<VaultSyncSignature> {
    const deviceId = await this.deviceId();
    const timestamp = Math.floor(this.clock.now().getTime() / 1000);
    const bytes = this.payload.build({ purpose: VaultSyncRequestSigner.PURPOSE, userId, deviceId, vaultId, operation, body, timestamp });
    const signature = await this.identity.signerFor(VaultSyncRequestSigner.PURPOSE).sign(bytes);
    return { deviceId, timestamp, signature };
  }
}
