// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { NobleCryptoPrimitives, WebCryptoRandomSource } from '@sulla/domain';
import { SystemClock } from '@sulla/foundation';

import { getConfiguredApprovalClient } from '@pkg/vault-broker';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { cloudRequest } from '../cloudFetch';
import { desktopDeviceIdentity } from '../device/DesktopDeviceIdentity';
import { CloudVaultSyncHttpTransport } from '../vaultSyncV3/transport';
import { VaultEnrollmentBrokerSource } from './BrokerEnrollmentKeyAgreement';
import { CloudEnrollmentTransport, type EnrollmentUserSource } from './CloudEnrollmentTransport';
import { DesktopEnrollmentCoordinator, type VaultUnlockNotifier } from './DesktopEnrollmentCoordinator';
import { ElectronEnrollmentApprovalGate } from './ElectronEnrollmentApprovalGate';
import { EnrollmentRequestOpener } from './OpenEnrollmentRequest';
import { VaultEnrollmentApprover } from './VaultEnrollmentApprover';
import { VaultSyncRequestSigner, type VaultSyncDeviceIdentity } from './VaultSyncRequestSigner';

class SignedInCloudUser implements EnrollmentUserSource {
  userId(): Promise<string> { return getCurrentUserId() }
}

/**
 * The process-wide device identity, looked up per call rather than captured when this module loads, so the
 * enrollment singleton follows `DesktopDeviceIdentity.useInstance()` and never touches ~/.sulla at import.
 */
class ProcessDeviceIdentity implements VaultSyncDeviceIdentity {
  deviceId(): ReturnType<VaultSyncDeviceIdentity['deviceId']> { return desktopDeviceIdentity().deviceId() }
  signerFor(purpose: Parameters<VaultSyncDeviceIdentity['signerFor']>[0]): ReturnType<VaultSyncDeviceIdentity['signerFor']> {
    return desktopDeviceIdentity().signerFor(purpose);
  }
}

class SullaVaultUnlockNotifier implements VaultUnlockNotifier {
  async vaultUnlocked(): Promise<void> {
    const { onVaultUnlocked } = await import('@pkg/sulla');
    await onVaultUnlocked();
  }
}

/** Wires Desktop vault enrollment (requester and approver) to Cloud, the device key and the vault broker. */
export class DesktopVaultEnrollmentModule {
  readonly coordinator: DesktopEnrollmentCoordinator;
  readonly approver: VaultEnrollmentApprover;

  /**
   * DEVICE IDENTITY SEAM — the only place enrollment gets its device identity. The default is this install's
   * one domain DeviceIdentityService, `desktopDeviceIdentity()` (main/cloud/device/DesktopDeviceIdentity.ts),
   * resolved on each call. Nothing else in enrollment touches the device id or key.
   */
  constructor(identity: VaultSyncDeviceIdentity = new ProcessDeviceIdentity()) {
    const crypto = new NobleCryptoPrimitives();
    const random = WebCryptoRandomSource.fromGlobal();
    const clock = new SystemClock();
    const http = new CloudVaultSyncHttpTransport({
      client: { request: (url, init) => cloudRequest(init?.method ?? 'GET', url, { headers: init?.headers as Record<string, string> | undefined, body: init?.body as BodyInit | undefined, responseType: 'json' }) },
      authHeaders: async() => ({}),
    });
    const transport = new CloudEnrollmentTransport(http, new VaultSyncRequestSigner(identity, crypto, clock), new SignedInCloudUser());
    const broker = new VaultEnrollmentBrokerSource(() => getConfiguredApprovalClient());
    this.coordinator = new DesktopEnrollmentCoordinator({
      session: new SignedInCloudUser(),
      transport,
      opener:  new EnrollmentRequestOpener(transport, globalThis.crypto.subtle, random),
      broker,
      unlock:  new SullaVaultUnlockNotifier(),
      clock,
      random,
      polling: DesktopEnrollmentCoordinator.POLLING,
    });
    this.approver = new VaultEnrollmentApprover(transport, new ElectronEnrollmentApprovalGate(), broker);
  }
}

export const DesktopVaultEnrollment = new DesktopVaultEnrollmentModule();
