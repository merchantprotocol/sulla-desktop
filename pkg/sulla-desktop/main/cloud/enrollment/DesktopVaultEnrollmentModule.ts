// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';

import { DeviceIdentityService, NobleCryptoPrimitives, WebCryptoRandomSource } from '@sulla/domain';
import { SystemClock } from '@sulla/foundation';

import paths from '@pkg/utils/paths';
import { getConfiguredApprovalClient } from '@pkg/vault-broker';
import { getDesktopDeviceId } from '../../deviceIdentity';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { cloudRequest } from '../cloudFetch';
import { getDevicePublicKey } from '../deviceKey';
import { CloudVaultSyncHttpTransport } from '../vaultSyncV3/transport';
import { VaultEnrollmentBrokerSource } from './BrokerEnrollmentKeyAgreement';
import { CloudEnrollmentTransport, type EnrollmentUserSource } from './CloudEnrollmentTransport';
import { DesktopEnrollmentCoordinator, type VaultUnlockNotifier } from './DesktopEnrollmentCoordinator';
import { ElectronEnrollmentApprovalGate } from './ElectronEnrollmentApprovalGate';
import { InterimDeviceIdStore, InterimDeviceKeyStore } from './InterimDeviceIdentityStores';
import { EnrollmentRequestOpener } from './OpenEnrollmentRequest';
import { VaultEnrollmentApprover } from './VaultEnrollmentApprover';
import { VaultSyncRequestSigner } from './VaultSyncRequestSigner';

class SignedInCloudUser implements EnrollmentUserSource {
  userId(): Promise<string> { return getCurrentUserId() }
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

  constructor() {
    const crypto = new NobleCryptoPrimitives();
    const random = WebCryptoRandomSource.fromGlobal();
    const clock = new SystemClock();
    // Swap these two stores for M4's adapters once its device identity lands (see InterimDeviceIdentityStores).
    const identity = new DeviceIdentityService(
      new InterimDeviceIdStore(() => getDesktopDeviceId(), () => path.join(paths.sullaConfig, 'device-id')),
      new InterimDeviceKeyStore(() => getDevicePublicKey(), () => path.join(paths.sullaConfig, 'device-key.json')),
      crypto, random, clock,
    );
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
