// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { loopbackOrigin } from '@pkg/utils/instance';
import crypto from 'node:crypto';
import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
import { LocalVaultApprovalClient } from './LocalVaultApprovalClient';
import { LocalVaultBrokerClient } from './index';
import { VaultBrokerError } from './VaultBrokerError';

const TOOLS_VAULT_ENDPOINT = 'https://sulla_vault:8787';
const DESKTOP_VAULT_ENDPOINT = loopbackOrigin('https', 30135);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VaultBrokerIdentityContextInput {
  agentId: string; podId: string; credentialScope: NonNullable<ToolExecutionContext['credential_scope']>;
  requestId?: string; threadId?: string; jobId?: string; workflowExecutionId?: string; orgId?: string; signal?: AbortSignal;
}

/** Owns lazy broker construction and its per-runtime cached clients. */
export class VaultBrokerServiceProvider {
  private configuredBroker: LocalVaultBrokerClient | null | undefined;
  private configuredApproval: LocalVaultApprovalClient | null | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly electronMain: () => boolean = () => Boolean(process.versions.electron) && (process as NodeJS.Process & { type?: string }).type === 'browser',
  ) {}

  configureCredentialBroker(broker: LocalVaultBrokerClient | null): void { this.configuredBroker = broker; }

  getConfiguredCredentialBroker(): LocalVaultBrokerClient | null {
    if (this.configuredBroker !== undefined) return this.configuredBroker;
    const token = this.env.SULLA_VAULT_BROKER_TOKEN;
    const serviceId = this.env.SULLA_VAULT_BROKER_SERVICE_ID;
    if (token && serviceId) {
      if (serviceId !== 'sulla-tools') throw new Error('Vault broker service identity must be sulla-tools');
      this.configuredBroker = new LocalVaultBrokerClient(
        this.env.SULLA_VAULT_BROKER_URL ?? TOOLS_VAULT_ENDPOINT,
        { serviceId, serviceToken: token },
        (input, init) => import('./toolsTransport').then(runtime => runtime.toolsVaultFetch(input, init)),
      );
    } else if (this.electronMain()) {
      const identity = async() => (await import('./desktopTransport')).loadDesktopBrokerIdentity();
      this.configuredBroker = new LocalVaultBrokerClient(
        DESKTOP_VAULT_ENDPOINT,
        identity,
        (input, init) => import('./desktopTransport').then(runtime => runtime.desktopVaultFetch(input, init)),
      );
    } else this.configuredBroker = null;
    return this.configuredBroker;
  }

  requireConfiguredCredentialBroker(): LocalVaultBrokerClient {
    const broker = this.getConfiguredCredentialBroker();
    if (!broker) throw new VaultBrokerError('vault_unavailable', 'Vault broker service identity is not configured', 503);
    return broker;
  }

  getConfiguredApprovalClient(): LocalVaultApprovalClient | null {
    if (this.configuredApproval !== undefined) return this.configuredApproval;
    if (!this.electronMain()) return this.configuredApproval = null;
    const identity = async() => (await import('./desktopTransport')).loadDesktopApprovalIdentity();
    const transport = (input: string, init?: RequestInit) => import('./desktopTransport').then(runtime => runtime.desktopVaultFetch(input, init));
    return this.configuredApproval = new LocalVaultApprovalClient(DESKTOP_VAULT_ENDPOINT, identity, transport);
  }

  async getLocalVaultPrincipalId(signal?: AbortSignal): Promise<string> {
    const status = await this.requireConfiguredCredentialBroker().status(signal);
    if (!status.unlocked) throw new VaultBrokerError('vault_locked', 'Vault is locked', 423);
    if (typeof status.principalId !== 'string' || !UUID_PATTERN.test(status.principalId)) {
      throw new VaultBrokerError('invalid_caller_identity', 'Vault did not return an authenticated local principal', 503);
    }
    return status.principalId;
  }

  async issueLocalBrokerContext(input: VaultBrokerIdentityContextInput): Promise<ToolExecutionContext> {
    if (!input.agentId.trim() || !input.podId.trim()) {
      throw new VaultBrokerError('invalid_caller_identity', 'Broker context requires trusted agent and pod identities', 401);
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: await this.getLocalVaultPrincipalId(input.signal),
      org_id: input.orgId, agent_id: input.agentId, pod_id: input.podId, thread_id: input.threadId,
      job_id: input.jobId, workflow_execution_id: input.workflowExecutionId,
      credential_scope: input.credentialScope, scopes: [], iat: now, exp: now + 300,
      jti: crypto.randomUUID(), request_id: input.requestId ?? crypto.randomUUID(),
    };
  }
}

export const configuredVaultBrokerProvider = new VaultBrokerServiceProvider();
