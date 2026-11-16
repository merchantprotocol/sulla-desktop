// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  AccountPasswordRewrapRequest, AccountPasswordRewrapResponse, BrokerApprovalResponse,
  BrokerExecuteResponse, BrokerIntegrationAccountImportRequest, BrokerIntegrationMetadataResponse,
  LocalVaultErrorResponse, RecoveryKeyRotateResponse, SullaCloudDesktopRequest,
  SullaCloudSessionAdoptRequest, SullaCloudSessionResponse, VaultDeviceApprovalWrapRequest,
  VaultEnrollmentAdoptRequest, VaultEnrollmentWrapRequest,
} from '../../../services/sulla-vault/src/contracts';
import { VaultBrokerError } from './VaultBrokerError';
import type { VaultBrokerFetch, VaultBrokerIdentityProvider, VaultBrokerServiceIdentity } from './index';

function safeReason(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}
function brokerError(body: LocalVaultErrorResponse, status: number): VaultBrokerError {
  return new VaultBrokerError(body.error, body.message, status, safeReason(body.reason), body.retryable === true);
}
function assertEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !['127.0.0.1', 'sulla_vault'].includes(url.hostname)) {
    throw new Error('Vault broker endpoint must use HTTPS at the configured Desktop or tools service address');
  }
  return url.toString().replace(/\/$/, '');
}
async function errorBody(response: Response): Promise<LocalVaultErrorResponse> {
  return response.json().catch(() => ({ error: 'vault_unavailable', message: `Vault broker request failed (${ response.status })` })) as Promise<LocalVaultErrorResponse>;
}

/** Construct only in the trusted Desktop approval path, never in tools/providers. */
export class LocalVaultApprovalClient {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly identity: VaultBrokerServiceIdentity | VaultBrokerIdentityProvider,
    private readonly transport: VaultBrokerFetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) }),
  ) {
    this.endpoint = assertEndpoint(endpoint);
    if (typeof identity !== 'function' && (!identity.serviceId || !identity.serviceToken)) {
      throw new Error('Vault approval service identity is not configured');
    }
  }

  async approve(operationId: string): Promise<BrokerApprovalResponse> {
    return this.request('/v1/broker/approve', 'POST', { operationId });
  }

  /** Create the empty vault account a first OAuth sign-in stores its tokens in. Metadata only. */
  async ensureOAuthAccount(integrationId: string, accountId: string, label: string): Promise<BrokerIntegrationMetadataResponse> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || !/^[A-Za-z0-9._-]{1,128}$/.test(accountId)) {
      throw new VaultBrokerError('invalid_operation', 'Integration account reference is invalid', 400);
    }
    return this.request(`/v1/broker/integrations/${ encodeURIComponent(integrationId) }/oauth-account`, 'PUT', { accountId, label });
  }

  /** Atomically store an account collected by trusted Desktop UI. No secret is returned. */
  async importIntegrationAccount(
    integrationId: string,
    input: BrokerIntegrationAccountImportRequest,
  ): Promise<BrokerIntegrationMetadataResponse> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.accountId)) {
      throw new VaultBrokerError('invalid_operation', 'Integration account reference is invalid', 400);
    }
    return this.request(`/v1/broker/integrations/${ encodeURIComponent(integrationId) }/desktop-account`, 'PUT', input);
  }

  async adoptSullaCloudSession(request: SullaCloudSessionAdoptRequest): Promise<SullaCloudSessionResponse> {
    return this.sullaCloudSession('PUT', request) as Promise<SullaCloudSessionResponse>;
  }

  async clearSullaCloudSession(): Promise<{ cleared: number }> {
    return this.sullaCloudSession('DELETE') as Promise<{ cleared: number }>;
  }

  async rewrapForAccountPassword(request: AccountPasswordRewrapRequest): Promise<AccountPasswordRewrapResponse> {
    return this.request('/v1/broker/sulla-cloud/account-wrap', 'POST', request);
  }

  async wrapUserKeyForApprovedDevice(request: VaultDeviceApprovalWrapRequest): Promise<{ wrappedUserKey: unknown }> {
    return this.request('/v1/broker/sulla-cloud/device-approval-wrap', 'POST', request);
  }

  async wrapVaultEnrollment(request: VaultEnrollmentWrapRequest): Promise<{ wrappedUserKey: unknown }> {
    return this.request('/v1/broker/sulla-cloud/enrollment-wrap', 'POST', request);
  }

  async adoptVaultEnrollment(request: VaultEnrollmentAdoptRequest): Promise<{ bundleMac: string; headMac: string }> {
    return this.request('/v1/broker/sulla-cloud/enrollment-adopt', 'POST', request);
  }

  async commitVaultEnrollment(requestId: string): Promise<{ adopted: true }> {
    return this.request('/v1/broker/sulla-cloud/enrollment-commit', 'POST', { requestId });
  }

  async rotateRecoveryKey(): Promise<RecoveryKeyRotateResponse> {
    return this.request('/v1/broker/sulla-cloud/recovery-key/rotate', 'POST', {});
  }

  async sullaCloudRequest(request: SullaCloudDesktopRequest): Promise<BrokerExecuteResponse> {
    return this.request('/v1/broker/sulla-cloud/request', 'POST', request);
  }

  private async sullaCloudSession(method: 'PUT' | 'DELETE', body?: SullaCloudSessionAdoptRequest): Promise<unknown> {
    return this.request('/v1/broker/sulla-cloud/session', method, body);
  }

  protected async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const identity = typeof this.identity === 'function' ? await this.identity() : this.identity;
    const response = await this.transport(`${ this.endpoint }${ path }`, {
      method,
      headers: {
        authorization: `Bearer ${ identity.serviceToken }`,
        'x-sulla-service-id': identity.serviceId,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw brokerError(await errorBody(response), response.status);
    }
    return response.json() as Promise<T>;
  }
}
