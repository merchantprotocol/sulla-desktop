// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import {
  createProviderCliBridge,
  type BrokerClaims,
  type BrokerExecuteRequest,
  type ProviderCliBridgeLease,
  type ToolExecutionContext,
} from '../../vault-broker';

import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';

import type { BaseThreadState } from '../nodes/Graph';

/** Short-lived caller claims; renewed on every bridge request while the process lives. */
const CONTEXT_TTL_S = 300;

export interface PendingCodexTokens {
  accessToken:      string;
  chatgptAccountId: string;
}

/**
 * First-run-only Codex execution path. The ChatGPT session that just signed
 * in lives solely in the main process's pending-credential map (see
 * FirstRunMemoryCustody / main/firstRun/pendingCredentials.ts) — there is no
 * vault yet to broker against, and Jonathon's first-run rule is that no
 * secret touches disk before the vault exists. This hands the guest Codex
 * CLI the exact opaque-capability shape vault-broker/providerCliBridge.ts
 * gives container runs (a random bridge token and a scoped relay path), but
 * resolves the upstream ChatGPT call directly against the in-memory tokens
 * instead of a vault credential lookup — the guest never sees the bearer or
 * the account id, only the capability.
 */
export async function createCodexPendingMemoryBridge(
  tokens: PendingCodexTokens,
  input: { conversationId: string; state?: BaseThreadState },
): Promise<ProviderCliBridgeLease> {
  if (!tokens.accessToken) throw new Error('Codex pending-memory bridge requires an access token');

  const metadata = (input.state?.metadata ?? {}) as { agentId?: string; wsChannel?: string; orgId?: string };
  const deviceId = await getDesktopDeviceId();
  const baseContext: ToolExecutionContext = {
    v:                1,
    iss:              'sulla-desktop',
    aud:              'sulla-tools',
    sub:              `first-run:${ deviceId }`,
    org_id:           metadata.orgId,
    agent_id:         metadata.agentId ?? metadata.wsChannel ?? 'sulla',
    pod_id:           `sulla-guest-codex-firstrun-${ crypto.randomUUID() }`,
    device_id:        deviceId,
    thread_id:        input.conversationId,
    job_id:           `guest-firstrun-${ crypto.randomUUID() }`,
    credential_scope: { integration_id: 'codex', account_id: 'first-run' },
    scopes:           [],
    iat:              Math.floor(Date.now() / 1_000),
    exp:              Math.floor(Date.now() / 1_000) + CONTEXT_TTL_S,
    jti:              crypto.randomUUID(),
    request_id:       crypto.randomUUID(),
  };
  const renewed = (): ToolExecutionContext => {
    const now = Math.floor(Date.now() / 1_000);
    return { ...baseContext, iat: now, exp: now + CONTEXT_TTL_S };
  };

  const toBrokerClaims = (ctx: ToolExecutionContext): BrokerClaims => {
    if (!ctx.sub || !ctx.agent_id || !ctx.pod_id) {
      throw new Error('Codex pending-memory bridge requires verified subject, agent_id, and pod_id claims');
    }
    return {
      sub: ctx.sub, agent_id: ctx.agent_id, pod_id: ctx.pod_id, org_id: ctx.org_id,
      thread_id: ctx.thread_id, job_id: ctx.job_id, workflow_execution_id: ctx.workflow_execution_id,
      credential_scope: ctx.credential_scope,
    };
  };

  // No vault exists yet, so there is nothing for a real broker to resolve an
  // injection field against. This stub plays the same role a configured
  // LocalVaultBrokerClient plays for a container run — it is the only place
  // the real bearer and chatgpt-account-id are read — but it injects them
  // from the first-run tokens handed to this function instead of a stored
  // vault credential.
  const broker = {
    requestFor: (ctx: ToolExecutionContext, request: Omit<BrokerExecuteRequest, 'claims'>): BrokerExecuteRequest => ({ ...request, claims: toBrokerClaims(ctx) }),
    executeStream: async(request: BrokerExecuteRequest, signal?: AbortSignal): Promise<Response> => fetch(request.url, {
      method: request.method,
      headers: {
        ...request.headers,
        'content-type':       'application/json',
        authorization:        `Bearer ${ tokens.accessToken }`,
        'chatgpt-account-id': tokens.chatgptAccountId,
      },
      body: JSON.stringify(request.body),
      signal,
    }),
  };

  return createProviderCliBridge({
    context:        renewed(),
    provider:       'codex',
    accountId:      'first-run',
    advertisedHost: new URL(getMCPServerHost().getVmReachableUrl()).hostname,
    authorize:      renewed,
    broker,
  });
}
