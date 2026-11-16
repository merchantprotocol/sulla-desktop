// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { LocalVaultError } from './LocalVaultError.js';
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';

/**
 * Constant-time checks of the fixed service identities (control, Desktop approval, broker) and
 * the bootstrap token used for helper proofs.
 * Moved verbatim from LocalVaultAuthority (E9); configuration is read from the host.
 */
export class ServiceIdentityGuard {
  constructor(private readonly host: LocalAuthorityHost) {}

  /** The Electron main approval identity (also used for Sulla Cloud relay). */
  requireApprovalIdentity(callerId: string, token: string | undefined): void {
    this.host.requireDesktopIdentity(callerId, token);
  }

  requireControlIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.host.config.controlServiceId || !LocalAuthorityCrypto.constantEqual(token, this.host.config.controlServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Desktop control identity is invalid');
    }
  }

  requireDesktopIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.host.config.approvalServiceId || !LocalAuthorityCrypto.constantEqual(token, this.host.config.approvalServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Desktop service identity is invalid');
    }
  }

  requireBrokerIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.host.config.brokerServiceId || !LocalAuthorityCrypto.constantEqual(token, this.host.config.brokerServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Broker service identity is invalid');
    }
  }

  bootstrapToken(): string {
    if (!this.host.config.bootstrapServiceToken || Buffer.byteLength(this.host.config.bootstrapServiceToken) < 32) {
      throw new LocalVaultError('vault_unavailable', 503, 'Bootstrap identity is not configured');
    }
    return this.host.config.bootstrapServiceToken;
  }
}
