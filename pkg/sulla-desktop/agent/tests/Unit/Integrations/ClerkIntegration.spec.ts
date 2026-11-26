// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import '../../Support/TestHomeEnv';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { BrokerCredentialFields } from '../../../../../../services/sulla-vault/src/localAuthority/BrokerCredentialFields';
import { BrokerExecutionService } from '../../../../../../services/sulla-vault/src/localAuthority/BrokerExecutionService';
import { BrokerRequestPreparer } from '../../../../../../services/sulla-vault/src/localAuthority/BrokerRequestPreparer';
import { ClerkAuthority, ClerkSavedPairRejectedError } from '../../../../../../services/sulla-vault/src/localAuthority/ClerkAuthority';
import { BrokerAuditRecorder } from '../../../../../../services/sulla-vault/src/localAuthority/BrokerAuditRecorder';
import { IntegrationAccountService } from '../../../../../../services/sulla-vault/src/localAuthority/IntegrationAccountService';
import { LocalVaultError } from '../../../../../../services/sulla-vault/src/localAuthority/LocalVaultError';
vi.mock('electron', () => {
  const app = { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false };
  return { default: { app }, app, ipcMain: { handle: vi.fn(), on: vi.fn() }, safeStorage: {} };
});

vi.mock('@pkg/agent/services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ connect: () => {}, onMessage: () => () => {}, send: async() => true }),
}));

import { ChatCompletionsServer } from '../../../../main/chatCompletionsServer';
import { ExecWorker } from '../../../tools/meta/exec';
import * as commandRunner from '../../../tools/util/CommandRunner';
import { ContainerSessionLeases } from '../../../services/ContainerSessionLeases';
import { agentContainerRuntimeRegistry } from '../../../services/AgentContainerRuntimeRegistry';
import { deriveCapabilitySigningKey, verifyCapabilityToken, issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import { HttpDesktopExecutor } from '../../../../../../packages/runtime-protocol/src/desktopExecutor';
import { getMCPServerHost, MCPServerHost } from '../../../../main/MCPServerHost';
import { toolRegistry } from '../../../tools/registry';
import type { BaseThreadState } from '../../../nodes/Graph';
import { startRelayToolTunnel, stopRelayToolTunnel } from '../../../../main/relayToolTunnel';
import { RelayToolTunnel } from '../../../../runtime/relayTunnelClient';
import { ClerkApiRoute } from '../../../../main/ClerkApiRoute';
import { configuredVaultBrokerProvider, LocalVaultBrokerClient } from '../../../../vault-broker';
import { ClerkClient, ClerkError, clerkSettings } from '../../../integrations/clerk/ClerkClient';
import { ClerkWorker } from '../../../tools/clerk/ClerkWorker';
import { clerkToolManifests } from '../../../tools/clerk/manifests';
import { ToolApprovalGate } from '../../../tools/ToolApprovalGate';
import { toolDecisionPort } from '../../../tools/toolDecisionPort';

import type { DecisionOutcome, DecisionRecord } from '@pkg/shared/decisions';

import type { BrokerExecuteRequest, BrokerExecuteResponse } from '../../../../../../services/sulla-vault/src/contracts';
import type { LocalAuthorityHost } from '../../../../../../services/sulla-vault/src/localAuthority/LocalAuthorityHost';
import type { ToolExecutionContext } from '../../../tools/executionContext';
import type { Request, Response as ExpressResponse } from 'express';

const context = {
  sub:              '01234567-89ab-4000-a000-0123456789ab',
  agent_id:         'test-agent',
  pod_id:           'test-pod',
  exp:              Number.MAX_SAFE_INTEGER,
  thread_id:        'test-thread',
  request_id:       'test-request',
  jti:              'test-jti',
  scopes:           ['clerk/*'],
  credential_scope: { integration_id: 'clerk', account_id: 'default' },
} as ToolExecutionContext;

const policy = { mode: 'agents', level: 'autofill', agents: [], sites: ['api.clerk.com'], expiresAt: null, askFirst: false, allowServerAgents: false };
const ok = (body: unknown = {}): BrokerExecuteResponse => ({ status: 200, headers: {}, body });
const testKey = 'sk_test_FAKE';
const liveKey = 'sk_live_FAKE';
const mockNow = Date.parse('2026-11-23T12:00:00Z');

function fixture(contextPort?: (caller: any) => Promise<ToolExecutionContext>) {
  const properties = {
    connection_status:          'connected',
    staging_instance_id:        'ins_stage',
    staging_secret_key:         testKey,
    staging_publishable_key:    'pk_test_RkFLRSQ',
    production_instance_id:     'ins_live',
    production_secret_key:      liveKey,
    production_publishable_key: 'pk_live_RkFLRSQ',
  };
  const item = { id: 'clerk-item', ciphertext: 'opaque-test-ciphertext', owner_user_id: context.sub, encrypted_item_key: 'fixture', agent_policy: policy, revision: 1 };
  const send = vi.fn((
    _url: URL, _method: string, _headers: Record<string, string>, _body?: unknown,
    _responseType?: string, _secrets?: string[], _generation?: number, _redactResponseBody?: boolean,
    _maxRequestBytes?: number, _maxResponseBytes?: number, _operation?: string, _integrationId?: string,
    _signal?: AbortSignal,
  ): Promise<BrokerExecuteResponse> => Promise.resolve(ok()));
  const validateTarget = vi.fn((input: string) => Promise.resolve(new URL(input)));
  const wait = vi.fn((_ms: number, _signal?: AbortSignal) => Promise.resolve());
  const pendingApprovals = new Map<string, number>();
  const pendingClerkApprovals = new Map<string, { digest: string; expiresAt: number }>();
  const approvals = new Map<string, { digest: string; expiresAt: number; clerkOperationId?: string }>();
  const auditRows: Record<string, unknown>[] = [];
  const hostParts: any = { upstream: { validateTarget, send }, brokerAudit: undefined };
  const host = {
    generation:            1,
    requireKeys:           () => ({ userId: context.sub }),
    requireGeneration:     vi.fn(),
    itemRepository:        { findOwnedIntegrationAccount: () => Promise.resolve({ rows: [{ ...item }] }) },
    openItemText:          () => Promise.resolve(JSON.stringify({ integration: { integrationId: 'clerk', properties }, agentPolicy: policy })),
    parts:                 hostParts,
    outboundAudit:         { record: (row: Record<string, unknown>) => auditRows.push(row) },
    config:                { approvalServiceId: 'approval-service', approvalServiceToken: 'fixture-approval-token' },
    pendingApprovals,
    pendingClerkApprovals,
    approvals,
    requireBrokerIdentity: vi.fn(),
  } as unknown as LocalAuthorityHost;
  hostParts.brokerAudit = new BrokerAuditRecorder(host);
  const brokerExecution = new BrokerExecutionService(host, () => mockNow);
  const authority = new ClerkAuthority(host, wait, () => mockNow);
  const requests: BrokerExecuteRequest[] = [];
  const broker = new LocalVaultBrokerClient('https://127.0.0.1', { serviceId: 'fixture', serviceToken: 'fake-token' }, async(_input, init) => {
    const request = JSON.parse(String(init?.body)) as BrokerExecuteRequest;
    requests.push(request);
    try {
      return Response.json(await authority.execute(request, init?.signal ?? undefined));
    } catch (error) {
      if (!(error instanceof LocalVaultError)) throw error;
      return Response.json({
        error:   error.code,
        message: error.code === 'approval_required' ? 'Owner approval is required' : error.message,
        ...(error.code === 'approval_required' ? { operationId: error.message } : {}),
        ...(error.code === 'approval_required' && error.approvalContext ? { approvalContext: error.approvalContext } : {}),
      }, { status: error.status });
    }
  });
  let settle!: (outcome: DecisionOutcome) => void;
  const result = new Promise<DecisionOutcome>(resolve => { settle = resolve });
  const decisionRecords = new Map<string, DecisionRecord>();
  const decide = vi.fn((input: any, timeout: number, _signal?: AbortSignal) => {
    const now = Date.now();
    const record = { ...input, id: 'test-decision', status: 'pending', attention: 'active', createdAt: now,
      expiresAt: now + timeout, relatedConversationIds: [] } as DecisionRecord;
    decisionRecords.set(String(input.payload?.clerkOperationId), record);
    return Promise.resolve({ record, result });
  });
  const findApprovalForPayload = vi.fn((key: string, value: string) => Promise.resolve(
    [...decisionRecords.values()].find(record => record.payload?.[key] === value),
  ));
  const authorize = vi.fn((operationId: string) => Promise.resolve(
    brokerExecution.approve('approval-service', 'fixture-approval-token', operationId).approvalId,
  ));
  const client = new ClerkClient({ broker, decisions: { request: decide, findApprovalForPayload }, authorize, context: contextPort ?? (() => Promise.resolve(context)) });
  const caller = { execution: context, conversationId: 'test-thread', channel: 'test-chat' };
  return {
    authority,
    brokerExecution,
    broker,
    host,
    client,
    caller,
    decide,
    authorize,
    settle: (status: DecisionOutcome['status']) => {
      const latest = [...decisionRecords.entries()].at(-1);
      if (latest) {
        const [operationId, record] = latest;
        decisionRecords.set(operationId, { ...record, status, ...(status === 'expired' ? { expiresAt: Date.now() - 1 } : {}) });
      }
      settle({ status, answers: [] });
    },
    settleOperation: (operationId: string, status: DecisionOutcome['status']) => {
      const record = decisionRecords.get(operationId);
      if (record) decisionRecords.set(operationId, { ...record, status, ...(status === 'expired' ? { expiresAt: Date.now() - 1 } : {}) });
    },
    properties,
    requests,
    send,
    validateTarget,
    item,
    wait,
    auditRows,
  };
}

function integrationAccountFixture(responses: Array<BrokerExecuteResponse | Error>) {
  const properties = {
    connection_status:          'connected',
    staging_instance_id:        'ins_stage',
    staging_secret_key:         testKey,
    staging_publishable_key:    'pk_test_RkFLRSQ',
    production_instance_id:     'ins_live',
    production_secret_key:      liveKey,
    production_publishable_key: 'pk_live_RkFLRSQ',
  };
  const plaintext = { type: 'apiKey', name: 'Clerk', agentPolicy: policy, integration: { integrationId: 'clerk', accountId: 'default', properties } };
  const item = { id: 'clerk-item', ciphertext: 'existing-ciphertext', encrypted_item_key: 'existing-key', revision: 7, owner_user_id: context.sub, agent_policy: policy };
  let sealedPlaintext: string | undefined;
  const send = vi.fn(async() => {
    const response = responses.shift() ?? ok();
    if (response instanceof Error) throw response;
    return response;
  });
  const updateIntegrationCiphertextIfRevision = vi.fn(async() => {
    item.revision++;
    return { rowCount: 1 };
  });
  const sealItem = vi.fn(async(value: string) => {
    sealedPlaintext = value;
    return { ciphertext: 'updated-ciphertext', encryptedItemKey: 'updated-key' };
  });
  const host = {
    generation: 1,
    requireDesktopIdentity: vi.fn(),
    requireGeneration: vi.fn(),
    requireKeys: () => ({ userId: context.sub, userKey: new Uint8Array([1]) }),
    itemRepository: {
      findOwnedIntegrationAccount: vi.fn(async() => ({ rows: [item], rowCount: 1 })),
      updateIntegrationCiphertextIfRevision,
    },
    openItemText: vi.fn(async() => JSON.stringify(plaintext)),
    sealItem,
    runSecurityOperation: async(operation: () => Promise<unknown>) => operation(),
    runTransaction: async(operation: (client: unknown) => Promise<unknown>) => operation({}),
    integrationStateRepository: { upsertImported: vi.fn(async() => {}) },
    auditHumanAction: vi.fn(async() => {}),
    parts: { upstream: { validateTarget: vi.fn(async(value: string) => new URL(value)), send } },
  } as unknown as LocalAuthorityHost;
  const service = new IntegrationAccountService(host);
  return {
    service,
    item,
    properties,
    send,
    sealItem,
    updateIntegrationCiphertextIfRevision,
    savedPlaintext: () => sealedPlaintext ? JSON.parse(sealedPlaintext) as typeof plaintext : undefined,
    save: (values: Record<string, string> = {
      staging_publishable_key: properties.staging_publishable_key,
      staging_secret_key: properties.staging_secret_key,
    }) => service.importDesktopIntegrationAccount('desktop', 'fixture-token', 'clerk', {
      accountId: 'default', label: 'Clerk', values, connected: true, active: true,
    }),
  };
}

function proxyRequest(body: unknown): Request {
  const envelope: Pick<Request, 'params' | 'body'> = { params: { accountId: 'default' }, body };
  // The Express boundary is synthetic; the route and Clerk collaborators are real.
  return envelope as Request;
}

function proxyResponse() {
  const response = new EventEmitter() as unknown as ExpressResponse;
  Object.assign(response, {
    writableEnded: false,
    status:        vi.fn(() => response),
    json:          vi.fn((payload: unknown) => { Object.assign(response, { writableEnded: true }); return payload }),
  });
  return response;
}

const destructive = [
  ['delete_user', 'DELETE', '/users/user_a', { user_id: 'user_a' }],
  ['delete_organization', 'DELETE', '/organizations/org_a', { organization_id: 'org_a' }],
  ['remove_membership', 'DELETE', '/organizations/org_a/memberships/user_a', { organization_id: 'org_a', user_id: 'user_a' }],
  ['revoke_session', 'POST', '/sessions/sess_a/revoke', { session_id: 'sess_a' }],
  ['revoke_invitation', 'POST', '/invitations/inv_a/revoke', { invitation_id: 'inv_a' }],
  ['revoke_organization_invitation', 'POST', '/organizations/org_a/invitations/inv_a/revoke', { organization_id: 'org_a', invitation_id: 'inv_a' }],
  ['remove_allowlist_identifier', 'DELETE', '/allowlist_identifiers/id_a', { identifier_id: 'id_a' }],
  ['remove_blocklist_identifier', 'DELETE', '/blocklist_identifiers/id_a', { identifier_id: 'id_a' }],
] as const;

describe('Clerk guarded egress', () => {
  it.each(destructive)('G1/G2: requires staging confirmation for %s', async(name, method, path, params) => {
    const f = fixture();
    await expect(f.client.named(name, params, f.caller)).rejects.toThrow('requires confirm: true');
    expect(f.send).not.toHaveBeenCalled();
    await f.client.named(name, { ...params, confirm: true }, f.caller);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0].pathname).toBe(`/v1${ path }`);
    expect(f.send.mock.calls[0][1]).toBe(method);
    expect(f.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['revoke_organization_invitation', { organization_id: 'org_a', invitation_id: 'inv_a', confirm: true }, {}],
    ['revoke_session', { session_id: 'sess_a', confirm: true }, {}],
    ['revoke_organization_invitation', { organization_id: 'org_a', invitation_id: 'inv_a', confirm: true, body: { requesting_user_id: 'user_a' } }, { requesting_user_id: 'user_a' }],
    ['revoke_session', { session_id: 'sess_a', confirm: true, body: { reset_client_trust: true } }, { reset_client_trust: true }],
    ['revoke_invitation', { invitation_id: 'inv_a', confirm: true }, undefined],
    ['ban_user', { user_id: 'user_a' }, undefined],
    ['unban_user', { user_id: 'user_a' }, undefined],
    ['lock_user', { user_id: 'user_a' }, undefined],
    ['unlock_user', { user_id: 'user_a' }, undefined],
  ] as const)('W3: %s sends a JSON body exactly where Clerk declares one (Clerk answers 415 otherwise)', async(name, input, wireBody) => {
    const f = fixture();
    await f.client.named(name, input, f.caller);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][1]).toBe('POST');
    expect(f.send.mock.calls[0][3]).toEqual(wireBody);
  });

  it('W3: a raw org-invitation revoke without a body also goes out as an empty JSON object', async() => {
    const f = fixture();
    await f.client.raw({ method: 'POST', path: '/organizations/org_a/invitations/inv_a/revoke', confirm: true }, f.caller);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][3]).toEqual({});
  });

  it.each(['true', 'yes', 1, [], {}, false])('G6: rejects non-boolean confirmation %j through the real BaseTool parser', async(confirm) => {
    const f = fixture();
    const worker = new ClerkWorker(() => f.client);
    worker.name = 'clerk_delete_user';
    worker.description = 'Delete a user';
    worker.schemaDef = clerkToolManifests.find(m => m.name === worker.name)!.schemaDef;
    worker.executionContext = context;
    const saved = toolDecisionPort.resolve();
    toolDecisionPort.register({ request: f.decide, requiresApproval: () => Promise.resolve(false) });
    try {
      const result = await worker.call({ user_id: 'user_a', environment: 'production', confirm });
      expect(result.success).toBe(false);
      expect(result.result).toContain('requires confirm: true');
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    } finally { toolDecisionPort.register(saved) }
  });

  it.each([
    ['production', liveKey],
    ['production', testKey],
    ['staging', liveKey],
  ])('G3/G7: requires separate approval for %s with either production signal (%s)', async(environment, key) => {
    const f = fixture();
    f.properties[environment === 'staging' ? 'staging_secret_key' : 'production_secret_key'] = key;
    if (environment === 'staging' && key === liveKey) f.properties.staging_instance_id = 'ins_live';
    const input = { user_id: 'user_a', environment, confirm: true };
    const pending = await f.client.named('delete_user', input, f.caller) as { status: 'approval_pending'; operationId: string };
    expect(pending).toMatchObject({ status: 'approval_pending', operationId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const expectedInstance = environment === 'staging' && key === liveKey ? 'ins_live' : environment === 'production' ? 'ins_live' : 'ins_stage';
    expect(f.decide).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining(`Clerk ${ environment } section (effective production, instance ${ expectedInstance }): DELETE /v1/users/user_a`),
    }), 10 * 60_000);
    expect(f.decide.mock.calls[0][0].title).not.toContain(key);
    const pendingAttempt = f.host.pendingClerkApprovals.get(pending.operationId);
    expect(pendingAttempt).toMatchObject({ expiresAt: mockNow + 10 * 60_000 });
    expect(pendingAttempt?.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pendingAttempt?.digest).not.toBe(pending.operationId);
    expect(f.host.pendingApprovals.size).toBe(0);
    expect(f.send).not.toHaveBeenCalled();

    // A request without the opaque attempt ID creates a fresh decision, never resumes the old one.
    f.settleOperation(pending.operationId, 'approved');
    const fresh = await f.client.named('delete_user', input, f.caller) as { status: 'approval_pending'; operationId: string };
    expect(fresh.status).toBe('approval_pending');
    expect(fresh.operationId).not.toBe(pending.operationId);
    expect(f.decide).toHaveBeenCalledTimes(2);
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();

    await f.client.named('delete_user', { ...input, operationId: pending.operationId }, f.caller);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][2].authorization).toBe(`Bearer ${ key }`);
    const approved = f.requests.at(-1)!;
    await expect(f.authority.execute(approved)).rejects.toThrow('already used');
    expect(f.send).toHaveBeenCalledTimes(1);
    const afterConsumed = await f.client.named('delete_user', input, f.caller) as { status: 'approval_pending'; operationId: string };
    expect(afterConsumed.operationId).not.toBe(pending.operationId);
    expect(afterConsumed.operationId).not.toBe(fresh.operationId);
    expect(f.decide).toHaveBeenCalledTimes(3);
  });

  it('keeps generic approval at two minutes while a Clerk attempt and its grant share one ten-minute window', async() => {
    const f = fixture();
    const input = { path: '/users/user_a', method: 'DELETE', environment: 'production', confirm: true };
    const pending = await f.client.raw(input, f.caller) as { status: 'approval_pending'; operationId: string };
    expect(f.host.pendingClerkApprovals.get(pending.operationId)?.expiresAt).toBe(mockNow + 10 * 60_000);

    f.settleOperation(pending.operationId, 'approved');
    const approvalId = await f.authorize(pending.operationId);
    expect(f.host.pendingClerkApprovals.has(pending.operationId)).toBe(false);
    expect(f.host.approvals.get(approvalId)).toMatchObject({
      clerkOperationId: pending.operationId,
      expiresAt: mockNow + 10 * 60_000,
    });

    f.host.pendingApprovals.set('generic-approval-digest', mockNow + 2 * 60_000);
    const genericGrant = f.brokerExecution.approve('approval-service', 'fixture-approval-token', 'generic-approval-digest');
    expect(genericGrant.expiresAt).toBe(mockNow + 2 * 60_000);
    expect(f.host.approvals.get(genericGrant.approvalId)).toMatchObject({
      digest: 'generic-approval-digest', expiresAt: mockNow + 2 * 60_000,
    });
    expect(f.host.approvals.get(genericGrant.approvalId)).not.toHaveProperty('clerkOperationId');
  });

  it('caps a Clerk grant at the original attempt expiry when approved late', async() => {
    const f = fixture();
    const input = { path: '/users/user_a', method: 'DELETE', environment: 'production', confirm: true };
    const pending = await f.client.raw(input, f.caller) as { status: 'approval_pending'; operationId: string };
    const attemptExpiry = f.host.pendingClerkApprovals.get(pending.operationId)!.expiresAt;
    const late = new BrokerExecutionService(f.host, () => mockNow + 9 * 60_000);
    const grant = late.approve('approval-service', 'fixture-approval-token', pending.operationId);
    expect(grant.expiresAt).toBe(attemptExpiry);
    expect(f.host.approvals.get(grant.approvalId)?.expiresAt).toBe(attemptExpiry);
  });

  it('does not let an approved Clerk attempt grant its authorization to a fresh identical attempt', async() => {
    const f = fixture();
    const input = { path: '/users/user_a', method: 'DELETE', environment: 'production', confirm: true };
    const first = await f.client.raw(input, f.caller) as { status: 'approval_pending'; operationId: string };
    f.settleOperation(first.operationId, 'approved');
    const staleApprovalId = await f.authorize(first.operationId);

    const second = await f.client.raw(input, f.caller) as { status: 'approval_pending'; operationId: string };
    expect(second.operationId).not.toBe(first.operationId);
    const secondRequest = f.requests.at(-1)!;
    await expect(f.authority.execute({
      ...secondRequest,
      approvalId: staleApprovalId,
      clerk: { ...secondRequest.clerk, operationId: second.operationId },
    })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(f.send).not.toHaveBeenCalled();

    f.settleOperation(second.operationId, 'approved');
    await f.client.raw({ ...input, operationId: second.operationId }, f.caller);
    expect(f.send).toHaveBeenCalledTimes(1);
    await expect(f.authority.execute(f.requests.at(-1)!)).rejects.toThrow('already used');
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each(['denied', 'expired'] as const)('G4: nothing sent when approval is %s', async(status) => {
    const f = fixture();
    const input = { path: '/sessions/sess_a/revoke', method: 'POST', environment: 'production', confirm: true };
    const pending = await f.client.raw(input, f.caller) as { status: 'approval_pending'; operationId: string };
    expect(pending.status).toBe('approval_pending');
    expect(f.send).not.toHaveBeenCalled();
    f.settle(status);
    await expect(f.client.raw({ ...input, operationId: pending.operationId }, f.caller)).rejects.toThrow(status);
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    const fresh = await f.client.raw(input, f.caller) as { status: 'approval_pending'; operationId: string };
    expect(fresh.operationId).not.toBe(pending.operationId);
    expect(f.decide).toHaveBeenCalledTimes(2);
  });

  it('G4: pending approval retries remain pending without authorizing or sending', async() => {
    const f = fixture();
    const input = { path: '/sessions/sess_a/revoke', method: 'POST', environment: 'production', confirm: true };
    const pending = await f.client.raw(input, f.caller) as { status: 'approval_pending'; operationId: string };
    expect(await f.client.raw({ ...input, operationId: pending.operationId }, f.caller)).toEqual(pending);
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('G4: does not auto-execute when a cancelled request later gets approval', async() => {
    const f = fixture();
    const abort = new AbortController();
    const input = { path: '/invitations/inv_a/revoke', method: 'POST', environment: 'production', confirm: true };
    const pending = await f.client.raw(input, { ...f.caller, signal: abort.signal }) as { status: 'approval_pending'; operationId: string };
    expect(pending.status).toBe('approval_pending');
    expect(f.send).not.toHaveBeenCalled();
    abort.abort();
    f.settle('approved');
    await expect(f.client.raw({ ...input, operationId: pending.operationId }, { ...f.caller, signal: abort.signal })).rejects.toThrow('cancelled');
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('aborts the active upstream request when a Clerk raw-call caller disconnects', async() => {
    const f = fixture();
    await f.client.raw({ path: '/users/user_a' }, f.caller);
    let reachWire!: (signal: AbortSignal) => void;
    const wireStarted = new Promise<AbortSignal>(resolve => { reachWire = resolve });
    f.send.mockImplementationOnce((_url, _method, _headers, _body, _responseType, _secrets, _generation, _redact, _maxRequestBytes, _maxResponseBytes, _operation, _integrationId, signal) =>
      new Promise<BrokerExecuteResponse>((_resolve, reject) => {
        if (!signal) throw new Error('Clerk wire request is missing its abort signal');
        reachWire(signal);
        signal.addEventListener('abort', () => reject(new Error('wire request aborted')), { once: true });
      }));
    const controller = new AbortController();
    const request = f.requests[0];
    const pending = f.authority.execute(request, controller.signal);
    const wireSignal = await wireStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'invalid_operation' });
    expect(wireSignal.aborted).toBe(true);
  });

  it('revalidates the live authorization context before an explicit approved retry', async() => {
    const signedContext = {
      ...context, pod_id: 'pod-a', request_id: 'proxy-request-a', jti: 'signed-jti-a',
      scopes: ['clerk/delete_user'],
    } as ToolExecutionContext;
    const refreshed = vi.fn()
      .mockResolvedValueOnce(signedContext)
      .mockResolvedValueOnce(signedContext)
      .mockRejectedValueOnce(new ClerkError(403, 'The Clerk tool session is invalid or expired.'));
    const f = fixture(() => refreshed());
    const input = { user_id: 'user_a', environment: 'production', confirm: true };
    const pending = await f.client.named('delete_user', input, {
      ...f.caller, execution: signedContext, toolName: 'clerk_delete_user',
    }) as { status: 'approval_pending'; operationId: string };
    f.settle('approved');
    await expect(f.client.named('delete_user', { ...input, operationId: pending.operationId }, {
      ...f.caller, execution: signedContext, toolName: 'clerk_delete_user',
    })).rejects.toThrow('authorization expired, was revoked, or changed');
    expect(refreshed).toHaveBeenCalledTimes(3);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('denies forwarded Clerk before broker access for live, renewed and mismatched container pairs', async() => {
    const name = 'clerk_get_user';
    const binding = { podId: 'fixture-pod', subject: context.sub, agentId: 'worker', threadId: 'thread', jobId: 'job', taskIndex: 0, deviceId: 'device', workspacePath: '/fixture' };
    const state = { metadata: { agentId: binding.agentId, threadId: binding.threadId, allowedToolNames: [name] } } as BaseThreadState;
    const host = getMCPServerHost();
    const originalPort = host['port'];
    host['port'] = 1; // The listening transport is in-process; no socket is opened.
    const serviceBearer = 'fixture-desktop';
    const key = deriveCapabilitySigningKey(serviceBearer);
    const written = new Map<string, string>();
    const leases = new ContainerSessionLeases(binding, host, [name], 'lifecycle', key, 60_000, {
      replace: async(key, value) => { written.set(key, value); },
      remove: async key => { written.delete(key); },
    });
    const a = host.registerSession(state, 120_000, binding);
    const unregister = agentContainerRuntimeRegistry.register(binding, leases);
    const b = agentContainerRuntimeRegistry.withRuntime(binding, () => host.registerSession(state, 120_000));
    const f = fixture();
    const broker = vi.spyOn(configuredVaultBrokerProvider, 'requireConfiguredCredentialBroker').mockReturnValue(f.broker);
    const local = vi.spyOn(configuredVaultBrokerProvider, 'issueLocalBrokerContext');
    toolRegistry.registerManifests(clerkToolManifests);

    const server = new ChatCompletionsServer();
    server['apiToken'] = serviceBearer;
    // Invoke the mounted private Express handler with serialized HTTP bytes, without listening or starting service storage.
    const endpoint = server['app'].router.stack.find((layer: { route?: { path?: string } }) =>
      layer.route?.path === '/internal/desktop-executor/:category/:tool').route.stack[0].handle;
    const http = new HttpDesktopExecutor('http://fixture.invalid', serviceBearer, async(url, init) => {
      const [, , , category, tool] = new URL(String(url)).pathname.split('/');
      const req = { params: { category, tool }, socket: { remoteAddress: '127.0.0.1' },
        headers: Object.fromEntries(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
      const res = proxyResponse();
      const result = await endpoint(req, res);
      return Response.json(result, { status: vi.mocked(res.status).mock.calls.at(-1)?.[0] ?? 200 });
    });
    const call = async(lease: string, session?: string) => {
      const claims = await verifyCapabilityToken(lease, key, { category: 'clerk', tool: name });
      return http.execute({ ...claims, request_id: 'fixture-request' }, 'clerk', 'get_user', { user_id: 'user_a' },
        { deadlineMs: 10_000, clerkToolSession: session });
    };
    try {
      const first = leases.issue(a.id);
      await b.prepareCliLease!();
      const second = [...written.values()][0];
      const forbidden = { success: false, error: { code: 'clerk_container_isolation_unavailable', details: { httpStatus: 403 } } };
      await expect(call(first, a.id)).resolves.toMatchObject(forbidden);
      await expect(call(second, b.id)).resolves.toMatchObject(forbidden);
      await expect(call(first, b.id)).resolves.toMatchObject(forbidden);
      await expect(call(second, a.id)).resolves.toMatchObject(forbidden);
      await expect(call(first)).resolves.toMatchObject(forbidden);
      await expect(call(first, serviceBearer)).resolves.toMatchObject(forbidden);
      const legacy = issueCapabilityToken({ sub: binding.subject, scopes: [name] }, key);
      await expect(call(legacy, a.id)).resolves.toMatchObject(forbidden);
      await leases.renew(a.id, () => host.rebindSession(a.id, state, 120_000, binding));
      await expect(call(written.get('SULLA_API_TOKEN')!, a.id)).resolves.toMatchObject(forbidden);
      expect(f.requests).toHaveLength(0);
      expect(f.send).not.toHaveBeenCalled();
      expect(local).not.toHaveBeenCalled();
      b.revoke();
      await expect(call(second, b.id)).resolves.toMatchObject(forbidden);
      await vi.waitFor(() => expect(written.size).toBe(1));
    } finally {
      a.revoke(); b.revoke(); unregister(); await leases.close();
      host['port'] = originalPort;
      local.mockRestore(); broker.mockRestore();
    }
  });

  it('selects the launcher, provider and nested-exec leases independently on every shell call', async() => {
    const dir = mkdtempSync(join(tmpdir(), 'clerk-lease-spec-'));
    const helper = fileURLToPath(new URL('../../../../../../services/sulla-agent/secret-env.sh', import.meta.url));
    const host = getMCPServerHost();
    const originalPort = host['port'];
    host['port'] = 1;
    const running = vi.spyOn(host, 'running', 'get').mockReturnValue(true);
    const binding = { podId: 'pod', jobId: 'job', subject: 'owner', deviceId: 'device', taskIndex: 0, workspacePath: '/fixture' };
    const key = deriveCapabilitySigningKey('shell fixture');
    const leases = new ContainerSessionLeases(binding, host, ['clerk/*'], 'lifecycle', key, 60_000, {
      replace: async(name, value) => { writeFileSync(join(dir, name), value, { mode: 0o600 }); },
      remove: async name => { rmSync(join(dir, name), { force: true }); },
    });
    const state = { metadata: { threadId: 'nested-thread' } } as BaseThreadState;
    const unregister = agentContainerRuntimeRegistry.register(binding, leases);
    for (const id of ['launcher', 'provider', 'nested']) host.rebindSession(id, state, 120_000, binding);
    const read = (id?: string) => spawnSync('sh', ['-ec',
      '. "$1"; load_sulla_tool_session "$2"; load_sulla_api_token "$2"; printf %s "$SULLA_API_TOKEN"',
      'test', helper, dir], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', SULLA_API_TOKEN: 'stale', ...(id ? { SULLA_TOOL_SESSION: id } : {}) } });
    const generation = async(id?: string) => {
      const result = read(id);
      expect(result.status).toBe(0);
      return (await verifyCapabilityToken(result.stdout, key)).tool_session_generation;
    };
    try {
      writeFileSync(join(dir, 'SULLA_TOOL_SESSION'), 'launcher');
      writeFileSync(join(dir, 'SULLA_API_TOKEN'), leases.issue('launcher'));
      await leases.prepare('provider');
      await leases.prepare('nested');
      expect(await generation()).toBe(host.peekToolSession('launcher')!.executionContext!.jti);
      const provider = await generation('provider');
      expect(provider).toBe(host.peekToolSession('provider')!.executionContext!.jti);
      expect(await generation('nested')).toBe(host.peekToolSession('nested')!.executionContext!.jti);
      expect(read('no-pair').status).not.toBe(0);

      // Run the real meta/exec registration and finally cleanup. Only the guest process boundary is replaced.
      const guest = vi.spyOn(commandRunner, 'runCommand').mockImplementation(async cmd => {
        const out = spawnSync('sh', ['-ec', cmd, 'fixture', helper, dir], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin' } });
        if (out.status !== 0) return { stdout: '', stderr: 'nested lease unavailable', exitCode: 1 };
        const [id, lease] = out.stdout.split('\n');
        const signed = await verifyCapabilityToken(lease, key);
        const live = host.peekToolSession(id);
        const matched = live?.state === state && live.executionContext?.jti === signed.tool_session_generation;
        return { stdout: matched ? 'paired' : 'unpaired', stderr: '', exitCode: matched ? 0 : 1 };
      });
      try {
        const exec = new ExecWorker();
        exec.setState(state);
        const result = await agentContainerRuntimeRegistry.withRuntime(binding, () => exec['_validatedCall']({
          command: '. "$1"; load_sulla_tool_session "$2"; load_sulla_api_token "$2"; printf "%s\\n%s" "$SULLA_TOOL_SESSION" "$SULLA_API_TOKEN"',
        }));
        expect(result).toMatchObject({ successBoolean: true, responseString: 'paired' });
      } finally { guest.mockRestore(); }

      host.rebindSession('nested', state, 120_000, binding);
      await leases.renew('launcher', () => host.rebindSession('launcher', state, 120_000, binding));
      expect(await generation('nested')).toBe(host.peekToolSession('nested')!.executionContext!.jti);
      expect(await generation('provider')).toBe(provider);
      host.revokeSession('nested');
      await leases.renew('launcher', () => host.rebindSession('launcher', state, 120_000, binding));
      expect(read('nested').status).not.toBe(0);
      await leases.close();
      expect(host.peekToolSession('provider')).toBeNull();
    } finally {
      for (const id of ['launcher', 'provider', 'nested']) host.revokeSession(id);
      unregister(); running.mockRestore(); host['port'] = originalPort;
      await leases.close(); rmSync(dir, { recursive: true });
    }
  });

  it.each(['host-local', 'container'])('projected %s MCP handler enforces host-only Clerk before dispatch and after approval', async(mode) => {
    const host = new MCPServerHost();
    const name = 'clerk_get_user';
    const state = { metadata: { agentId: context.agent_id, threadId: context.thread_id, allowedToolNames: [name] } } as BaseThreadState;
    const binding = mode === 'container' ? {
      podId: 'test-pod', subject: context.sub, agentId: context.agent_id, threadId: context.thread_id,
      jobId: 'job', deviceId: 'device', workspacePath: '/fixture',
    } : undefined;
    host['port'] = 1;
    const { id } = host.registerSession(state, 60_000, binding);
    if (binding) {
      const issuer = new ContainerSessionLeases(binding, host, [name], 'fixture', deriveCapabilitySigningKey('fixture'),
        60_000, { replace: async() => {}, remove: async() => {} });
      issuer.issue(id);
    }
    const session = host.getToolSession(id)!;
    toolRegistry.registerManifests(clerkToolManifests);
    const handler = (host as any).buildMcpServer(session)._registeredTools.sulla_tool.handler;
    const f = fixture();
    const broker = vi.spyOn(configuredVaultBrokerProvider, 'requireConfiguredCredentialBroker').mockReturnValue(f.broker);
    const issue = vi.spyOn(configuredVaultBrokerProvider, 'issueLocalBrokerContext').mockResolvedValue({ ...context, pod_id: 'desktop-main' });
    const saved = toolDecisionPort.resolve();
    let needsApproval = false;
    toolDecisionPort.register({ request: f.decide, requiresApproval: async() => needsApproval });
    const invoke = () => handler({ tool: name, args: { user_id: 'user_a' } }, { signal: new AbortController().signal });
    try {
      if (binding) {
        const denied = await invoke();
        expect(denied.isError).toBe(true);
        expect(denied.content[0].text).toContain('clerk_container_isolation_unavailable');
        expect(issue).not.toHaveBeenCalled();
        expect(f.send).not.toHaveBeenCalled();
        return;
      }
      expect((await invoke()).isError).toBe(false);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(issue).toHaveBeenCalledWith(expect.objectContaining({
        agentId: context.agent_id, threadId: context.thread_id, podId: 'desktop-main', signal: expect.anything(),
      }));
      needsApproval = true;
      const waiting = invoke();
      await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
      host.revokeSession(id);
      f.settle('approved');
      expect((await waiting).isError).toBe(true);
      expect((await invoke()).isError).toBe(true);
      expect(f.requests).toHaveLength(1);
    } finally {
      host.revokeSession(id);
      toolDecisionPort.register(saved);
      issue.mockRestore();
      broker.mockRestore();
    }
  });

  it('keeps the internal Clerk worker bound to its live session across explicit retry', async() => {
    let sessionActive = true;
    const revalidate = vi.fn(async() => {
      if (!sessionActive) throw new ClerkError(403, 'The Clerk tool session is invalid or expired.');
      return context;
    });
    const f = fixture(async caller => {
      await caller.revalidate?.();
      return context;
    });
    const worker = new ClerkWorker(() => f.client);
    worker.name = 'clerk_delete_user';
    worker.description = 'Delete a user';
    worker.schemaDef = clerkToolManifests.find(manifest => manifest.name === worker.name)!.schemaDef;
    worker.executionContext = context;
    worker.bindClerkCaller({ ...f.caller, execution: context, toolName: worker.name, deadlineAt: Date.now() + 100_000, revalidate });
    const saved = toolDecisionPort.resolve();
    toolDecisionPort.register({ request: f.decide, requiresApproval: () => Promise.resolve(false) });
    try {
      const input = { user_id: 'user_a', environment: 'production', confirm: true };
      const first = await worker.call(input);
      const pending = first.result as { status: string; operationId: string };
      expect(first.success).toBe(true);
      expect(pending.status).toBe('approval_pending');
      sessionActive = false;
      f.settle('approved');
      const result = await worker.call({ ...input, operationId: pending.operationId });

      expect(result.success).toBe(false);
      expect(result.result).toContain('The Clerk tool session is invalid or expired.');
      expect(revalidate).toHaveBeenCalledTimes(2);
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    } finally { toolDecisionPort.register(saved) }
  });

  it('preserves failed Clerk ToolResult status and safe Retry-After', async() => {
    const f = fixture();
    f.send.mockResolvedValue({ status: 429, headers: { 'retry-after': '2' }, body: {} });
    const worker = new ClerkWorker(() => f.client);
    worker.name = 'clerk_get_user';
    worker.description = 'Get a user';
    worker.schemaDef = clerkToolManifests.find(manifest => manifest.name === worker.name)!.schemaDef;
    worker.executionContext = context;
    const saved = toolDecisionPort.resolve();
    toolDecisionPort.register({ request: f.decide, requiresApproval: () => Promise.resolve(false) });
    try {
      const result = await worker.call({ user_id: 'user_a' });
      expect(result).toMatchObject({ success: false, status: 429, retryAfter: '2' });
      expect(result.result).toContain('rate limiting');
      expect(f.send).toHaveBeenCalledTimes(3);
      expect(f.wait.mock.calls.map(([ms]) => ms)).toEqual([2_000, 2_000]);
    } finally { toolDecisionPort.register(saved) }
  });

  it('refuses an approved retry when the live caller scope changes', async() => {
    const signedContext = {
      ...context, request_id: 'proxy-request-scope', jti: 'signed-jti-scope', scopes: ['clerk/delete_user'],
    } as ToolExecutionContext;
    const reducedScope = { ...signedContext, scopes: ['clerk/list_users'] } as ToolExecutionContext;
    const refreshed = vi.fn().mockResolvedValueOnce(signedContext).mockResolvedValueOnce(reducedScope);
    const f = fixture(() => refreshed());
    const input = { user_id: 'user_a', environment: 'production', confirm: true };
    const pending = await f.client.named('delete_user', input, {
      ...f.caller, execution: signedContext, toolName: 'clerk_delete_user',
    }) as { status: 'approval_pending'; operationId: string };
    f.settle('approved');
    await expect(f.client.named('delete_user', { ...input, operationId: pending.operationId }, {
      ...f.caller, execution: signedContext, toolName: 'clerk_delete_user',
    })).rejects.toThrow('not available to this caller');
    expect(refreshed).toHaveBeenCalledTimes(2);
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('always consumes stale approval IDs after a live-to-test rotation or askFirst policy change', async() => {
    const rotated = fixture();
    rotated.properties.staging_secret_key = liveKey;
    rotated.properties.staging_instance_id = 'ins_live';
    const input = { path: '/sessions/sess_a/revoke', method: 'POST', environment: 'staging', confirm: true };
    const pending = await rotated.client.raw(input, rotated.caller) as { status: 'approval_pending'; operationId: string };
    rotated.properties.staging_secret_key = testKey;
    rotated.properties.staging_instance_id = 'ins_stage';
    rotated.item.revision++;
    rotated.settle('approved');
    await expect(rotated.client.raw({ ...input, operationId: pending.operationId }, rotated.caller)).rejects.toThrow('connection changed');
    expect(rotated.authorize).toHaveBeenCalledTimes(1);
    expect(rotated.send).not.toHaveBeenCalled();

    const policyChanged = fixture();
    policyChanged.item.agent_policy = { ...policy, askFirst: true };
    const read = { user_id: 'user_a' };
    const askFirst = await policyChanged.client.named('get_user', read, policyChanged.caller) as { status: 'approval_pending'; operationId: string };
    policyChanged.item.agent_policy = { ...policy, askFirst: false };
    policyChanged.item.revision++;
    policyChanged.settle('approved');
    await expect(policyChanged.client.named('get_user', { ...read, operationId: askFirst.operationId }, policyChanged.caller)).rejects.toThrow('connection changed');
    expect(policyChanged.authorize).toHaveBeenCalledTimes(1);
    expect(policyChanged.send).not.toHaveBeenCalled();
  });

  it.each([
    ['environment', { environment: 'staging' }],
    ['request target', { user_id: 'user_b' }],
  ] as const)('does not reuse an approval after the %s changes', async(_name, change) => {
    const f = fixture();
    const input = { user_id: 'user_a', environment: 'production', confirm: true };
    const pending = await f.client.named('delete_user', input, f.caller) as { status: 'approval_pending'; operationId: string };
    f.settle('approved');
    await expect(f.client.named('delete_user', { ...input, ...change, operationId: pending.operationId }, f.caller))
      .rejects.toThrow('not available to this caller');
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('rechecks the selected item revision after async target resolution and before retries', async() => {
    const afterResolution = fixture();
    afterResolution.validateTarget.mockImplementationOnce(async(input) => {
      afterResolution.item.revision++;
      return new URL(input);
    });
    await expect(afterResolution.client.named('get_user', { user_id: 'user_a' }, afterResolution.caller)).rejects.toThrow('settings changed');
    expect(afterResolution.send).not.toHaveBeenCalled();

    const beforeRetry = fixture();
    beforeRetry.send.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '1' }, body: {} });
    beforeRetry.wait.mockImplementationOnce(async() => { beforeRetry.item.revision++ });
    await expect(beforeRetry.client.named('get_user', { user_id: 'user_a' }, beforeRetry.caller)).rejects.toThrow('settings changed');
    expect(beforeRetry.send).toHaveBeenCalledTimes(1);
  });

  it('S2: settings verification honors fitting Retry-After and exposes an over-budget delay', async() => {
    const publishable = `pk_test_${ Buffer.from('clerk.example.invalid$').toString('base64') }`;
    const f = fixture();
    f.send.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '5' }, body: {} })
      .mockResolvedValueOnce(ok({ id: 'ins_stage', environment_type: 'development' }))
      .mockResolvedValueOnce(ok({ data: [{ frontend_api_url: 'https://clerk.example.invalid' }] }));
    await f.authority.verifySettings({ staging_publishable_key: publishable, staging_secret_key: testKey }, {}, 1, false);
    expect(f.wait).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
    expect(f.send).toHaveBeenCalledTimes(3);

    const delayed = fixture();
    delayed.send.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '30' }, body: {} });
    await expect(delayed.authority.verifySettings({ staging_publishable_key: publishable, staging_secret_key: testKey }, {}, 1, false))
      .rejects.toThrow('Retry in 30 seconds');
    expect(delayed.wait).not.toHaveBeenCalled();
    expect(delayed.send).toHaveBeenCalledTimes(1);
  });

  it('accepts only documented destructive options, summarizes them safely, and binds them to explicit approval retry', async() => {
    const session = fixture();
    const sessionInput = {
      session_id: 'sess_a', environment: 'production', confirm: true, body: { reset_client_trust: true },
    };
    const sessionPending = await session.client.named('revoke_session', sessionInput, session.caller) as { status: 'approval_pending'; operationId: string };
    expect(session.decide.mock.calls[0][0].title).toContain('reset_client_trust=true');
    expect(session.decide.mock.calls[0][0].title).toContain('effective production, instance ins_live');
    expect(session.decide.mock.calls[0][0].title).not.toContain(testKey);
    expect(session.send).not.toHaveBeenCalled();
    session.settle('approved');
    await session.client.named('revoke_session', { ...sessionInput, operationId: sessionPending.operationId }, session.caller);
    expect(session.send.mock.calls[0][3]).toEqual({ reset_client_trust: true });

    const organizationInvite = fixture();
    const inviteInput = {
      organization_id: 'org_a', invitation_id: 'inv_a', environment: 'production', confirm: true,
      body: { requesting_user_id: 'user_actor' },
    };
    const invitePending = await organizationInvite.client.named('revoke_organization_invitation', inviteInput, organizationInvite.caller) as { status: 'approval_pending'; operationId: string };
    expect(organizationInvite.decide.mock.calls[0][0].title).toContain('requesting_user_id=user_actor');
    organizationInvite.settle('approved');
    await organizationInvite.client.named('revoke_organization_invitation', { ...inviteInput, operationId: invitePending.operationId }, organizationInvite.caller);
    expect(organizationInvite.send.mock.calls[0][3]).toEqual({ requesting_user_id: 'user_actor' });

    const tampered = fixture();
    await tampered.client.named('get_user', { user_id: 'user_a' }, tampered.caller);
    const base = tampered.requests[0];
    const approvalRequest = {
      ...base,
      url: 'https://api.clerk.com/v1/sessions/sess_a/revoke', method: 'POST',
      body: { reset_client_trust: true },
      clerk: { environment: 'production' as const, confirm: true, deadlineAt: mockNow + 30_000 },
    };
    await expect(tampered.authority.execute(approvalRequest)).rejects.toMatchObject({ code: 'approval_required' });
    const attemptId = [...tampered.host.pendingClerkApprovals.keys()][0];
    const approvalId = await tampered.authorize(attemptId);
    await expect(tampered.authority.execute({
      ...approvalRequest, approvalId, clerk: { ...approvalRequest.clerk, operationId: attemptId }, body: { reset_client_trust: false },
    })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(tampered.send).toHaveBeenCalledTimes(1);
  });

  it('rejects ignore_existing on named and raw invitation creates, including casing variants and query keys', async() => {
    const f = fixture();
    await expect(f.client.named('create_invitation', {
      body: { email_address: 'new@example.invalid', ignore_existing: true },
    }, f.caller)).rejects.toThrow('ignore_existing');
    await expect(f.client.raw({
      method: 'POST', path: '/invitations', body: { email_address: 'new@example.invalid', IGNORE_EXISTING: true },
    }, f.caller)).rejects.toThrow('ignore_existing');
    await expect(f.client.raw({
      method: 'POST', path: '/organizations/org_a/invitations', query: { Ignore_Existing: true },
    }, f.caller)).rejects.toThrow('ignore_existing');
    await f.client.named('get_user', { user_id: 'user_a' }, f.caller);
    const base = f.requests[0];
    await expect(f.authority.execute({
      ...base, url: 'https://api.clerk.com/v1/invitations', method: 'POST',
      body: { email_address: 'new@example.invalid', Ignore_Existing: true },
      clerk: { environment: 'staging', confirm: false, deadlineAt: mockNow + 30_000 },
    })).rejects.toThrow('ignore_existing');
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('audits successful credential use with actor, operation, item, and origin only', async() => {
    const f = fixture();
    const marker = 'synthetic-request-body-marker';
    await f.client.named('update_user_metadata', {
      user_id: 'user_a', body: { public_metadata: { note: marker } },
    }, f.caller);
    expect(f.auditRows).toHaveLength(1);
    expect(f.auditRows[0]).toMatchObject({
      actorUserId: context.sub, agentId: context.agent_id, itemId: f.item.id,
      operation: 'clerk.backend', destination: 'https://api.clerk.com', blocked: false,
    });
    expect(f.auditRows[0]).not.toHaveProperty('orgId');
    expect(f.auditRows[0]).not.toHaveProperty('collectionId');
    expect(f.auditRows[0]).not.toHaveProperty('podId');
    expect(JSON.stringify(f.auditRows[0])).not.toContain(marker);
    expect(JSON.stringify(f.auditRows[0])).not.toContain(testKey);
  });

  it.each(['disconnect', 'rotate'] as const)('refuses an already-approved explicit retry after a pending %s', async(change) => {
    const f = fixture();
    const input = { path: '/users/user_a', method: 'DELETE', environment: 'production', confirm: true };
    const pending = await f.client.raw(input, f.caller) as { status: 'approval_pending'; operationId: string };
    if (change === 'disconnect') f.properties.connection_status = 'disconnected';
    else f.item.revision++;
    f.settle('approved');
    await expect(f.client.raw({ ...input, operationId: pending.operationId }, f.caller)).rejects.toThrow(change === 'disconnect' ? 'not connected' : 'connection changed');
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    ['get_user', 'clerk_get_user', { params: { user_id: 'user_a' } }],
    ['clerk_raw_request', 'clerk_raw_request', { path: '/users/user_a' }],
    [undefined, 'clerk_raw_request', { path: '/users/user_a' }],
  ] as const)('holds HTTP %s behind its canonical Decide policy until approved', async(endpoint, canonical, input) => {
    const f = fixture();
    const requiresApproval = vi.fn(async(name: string) => name === canonical);
    const route = new ClerkApiRoute(() => f.client, async(_request, _name, signal) => ({ ...f.caller, signal }),
      new ToolApprovalGate({ request: f.decide, requiresApproval }));
    const response = proxyResponse();
    const dispatched = route.handle(proxyRequest(input), response, endpoint);
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    expect(f.decide.mock.calls[0][0]).toMatchObject({ kind: 'approval', toolName: canonical, conversationId: 'test-thread' });
    expect(f.requests).toHaveLength(0);
    expect(f.send).not.toHaveBeenCalled();
    f.settle('approved');
    await dispatched;
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(requiresApproval).toHaveBeenCalledTimes(1);
    expect(f.decide).toHaveBeenCalledTimes(1);
  });

  it('rejects wrapped Clerk raw envelopes on both API routes before applying defaults', async() => {
    const f = fixture();
    const route = new ClerkApiRoute(() => f.client, (_request, _name, signal) => Promise.resolve({ ...f.caller, signal }),
      new ToolApprovalGate({ request: f.decide, requiresApproval: async() => false }));
    for (const endpoint of [undefined, 'clerk_raw_request']) {
      const response = proxyResponse();
      await route.handle(proxyRequest({ params: { path: '/users/user_a' } }), response, endpoint);
      expect(response.status).toHaveBeenCalledWith(400);
      expect(f.requests).toHaveLength(0);
    }
    expect(f.send).not.toHaveBeenCalled();

    const flat = proxyResponse();
    await route.handle(proxyRequest({ path: '/users/user_a' }), flat, 'clerk_raw_request');
    expect(flat.json).toHaveBeenCalledWith({ success: true, result: {} });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('G5: raw, generic proxy and attempted generic catalog bypass all fail closed', async() => {
    const f = fixture();
    const input = { method: 'POST', path: '/organizations/org_a/invitations/inv_a/revoke', environment: 'production', confirm: 'true' };
    await expect(f.client.named('raw_request', input, f.caller)).rejects.toThrow('requires confirm');
    const proxy = new ClerkApiRoute(() => f.client, (_request, _name, signal) => Promise.resolve({ ...f.caller, signal }),
      new ToolApprovalGate({ request: f.decide, requiresApproval: async() => false }));
    const response = proxyResponse();
    const request = proxyRequest(input);
    await proxy.handle(request, response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ success: false, error: expect.stringContaining('requires confirm') });
    await expect(new BrokerRequestPreparer(f.host).prepareBrokerRequest({
      ...f.requests[0], operation: 'catalog.http',
    }, 'fixture', 'fake-token')).rejects.toThrow('guarded Clerk integration');
    expect(f.send).not.toHaveBeenCalled();
    const approvedResponse = proxyResponse();
    await proxy.handle(proxyRequest({ ...input, confirm: true }), approvedResponse);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    const responseBody = (approvedResponse.json as any).mock.calls[0][0] as { result: { status: string; operationId: string } };
    expect(responseBody.result.status).toBe('approval_pending');
    f.settle('approved');
    const retryResponse = proxyResponse();
    await proxy.handle({ ...request, body: { ...input, confirm: true, operationId: responseBody.result.operationId } } as Request, retryResponse);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each(['/sessions/sess_a/%72evoke', '/sessions/sess_a/revoke/', '/users/../users/user_a', '//example.invalid/users'])('refuses ambiguous target %s before any Clerk request', async(path) => {
    const f = fixture();
    await expect(f.client.raw({ method: 'POST', path, confirm: true }, f.caller)).rejects.toThrow('Invalid Clerk Backend API path');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('rejects malformed Vault approval operation IDs before egress', async() => {
    const f = fixture();
    await f.client.raw({ path: '/users/user_a' }, f.caller);
    const original = f.requests[0];
    await expect(f.authority.execute({
      ...original, clerk: { ...original.clerk!, operationId: 'not-an-opaque-approval-id' },
    })).rejects.toMatchObject({ code: 'invalid_operation', status: 400 });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('rejects method overrides and caller-owned auth headers', async() => {
    const f = fixture();
    await expect(f.client.raw({ path: '/users/user_a', method: 'POST', query: { _method: 'DELETE' } }, f.caller)).rejects.toThrow('override');
    await expect(f.client.raw({ path: '/users', headers: { authorization: 'fake' } }, f.caller)).rejects.toThrow('headers');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('S1: scrubs both keys even in parsed payload keys and omits untrusted errors', async() => {
    const f = fixture();
    f.send.mockResolvedValueOnce(ok({ [testKey]: [`Bearer ${ liveKey }`] }));
    expect(JSON.stringify(await f.client.named('get_user', { user_id: 'user_a' }, f.caller))).not.toMatch(/sk_(test|live)_FAKE/);
    f.send.mockResolvedValueOnce({ status: 422, headers: {}, body: { errors: [{ code: 'form_identifier_exists', long_message: testKey }] } });
    await expect(f.client.named('create_user', { body: { email_address: ['test@example.invalid'] } }, f.caller)).rejects.toThrow('already exists');
    const publicMetadata = BrokerCredentialFields.safeIntegrationMetadata(f.properties, 'clerk');
    expect(publicMetadata.staging_publishable_key).toBe(f.properties.staging_publishable_key);
    expect(publicMetadata.production_publishable_key).toBe(f.properties.production_publishable_key);
    expect(JSON.stringify(publicMetadata)).not.toMatch(/sk_(test|live)_FAKE/);
  });

  it('S2: waits per Retry-After and stops after two delays; long delays are never shortened', async() => {
    const f = fixture();
    const limited = (value: string) => ({ status: 429, headers: { 'retry-after': value }, body: {} });
    f.send.mockResolvedValueOnce(limited('1')).mockResolvedValueOnce(limited(new Date(mockNow + 2000).toUTCString())).mockResolvedValueOnce(limited('2'));
    await expect(f.client.named('get_user', { user_id: 'user_a' }, f.caller)).rejects.toThrow('rate limiting');
    expect(f.wait.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    expect(f.send).toHaveBeenCalledTimes(3);
    f.send.mockResolvedValueOnce(limited('101'));
    await expect(f.client.named('get_user', { user_id: 'user_a' }, f.caller)).rejects.toThrow('Retry in 101 seconds');
    expect(f.send).toHaveBeenCalledTimes(4);
    expect(f.wait).toHaveBeenCalledTimes(2);
  });

  it('caps Clerk retries to 15 seconds and preserves over-budget Retry-After', async() => {
    const f = fixture();
    await f.client.raw({ path: '/users/user_a' }, f.caller);
    let now = mockNow;
    const authority = new ClerkAuthority(f.host, f.wait, () => now);
    const request = {
      ...f.requests[0],
      method: 'DELETE',
      url: 'https://api.clerk.com/v1/users/user_a',
      clerk: { environment: 'production', confirm: true, deadlineAt: mockNow + 100_000 },
    } as BrokerExecuteRequest;
    let attemptId = '';
    try {
      await authority.execute(request);
    } catch (error) {
      attemptId = (error as Error).message;
      expect(error).toMatchObject({ code: 'approval_required' });
    }
    const approvalId = await f.authorize(attemptId);
    now += 50_000;
    f.send.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '80' }, body: {} });

    const response = await authority.execute({
      ...request, approvalId, clerk: { ...request.clerk, operationId: attemptId },
    });

    expect(response).toMatchObject({ status: 429, headers: { 'retry-after': '80' } });
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it('gives an explicit approval retry a fresh bounded request deadline', async() => {
    const f = fixture();
    const input = { path: '/users/user_a', method: 'DELETE', environment: 'production', confirm: true };
    const firstCallerDeadline = Date.now() + 10_000;
    const pending = await f.client.raw(input, { ...f.caller, deadlineAt: firstCallerDeadline }) as { status: 'approval_pending'; operationId: string };
    const firstDeadline = f.requests[0].clerk?.deadlineAt;
    expect(typeof firstDeadline).toBe('number');
    expect(firstDeadline!).toBeLessThanOrEqual(firstCallerDeadline);
    f.settle('approved');

    const retryCallerDeadline = Date.now() + 30_000;
    await f.client.raw({ ...input, operationId: pending.operationId }, { ...f.caller, deadlineAt: retryCallerDeadline });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1].clerk?.operationId).toBe(pending.operationId);
    expect(f.requests[1].clerk?.deadlineAt).toBeGreaterThan(firstDeadline!);
    expect(f.requests[1].clerk?.deadlineAt).toBeLessThanOrEqual(retryCallerDeadline);
  });

  it('caps a long caller-provided deadline to the Clerk request budget', async() => {
    const f = fixture();
    const startedAt = Date.now();
    await f.client.raw({ path: '/users/user_a' }, {
      ...f.caller, deadlineAt: startedAt + 10 * 60_000,
    });

    expect(f.requests[0].clerk?.deadlineAt).toBeGreaterThanOrEqual(startedAt + 15_000);
    expect(f.requests[0].clerk?.deadlineAt).toBeLessThanOrEqual(Date.now() + 15_000);
  });

  it('shares one settings verification deadline across both sections and their lookups', async() => {
    const f = fixture();
    let now = mockNow;
    const wait = vi.fn(async(ms: number) => { now += ms });
    const authority = new ClerkAuthority(f.host, wait, () => now);
    let calls = 0;
    f.send.mockImplementation(async() => {
      calls++;
      if (calls === 1) {
        now += 20_000;
        return ok({ id: 'ins_stage', environment_type: 'development' });
      }
      if (calls === 2) {
        now += 4_000;
        return ok({ data: [{ frontend_api_url: 'https://fake' }] });
      }
      return { status: 429, headers: { 'retry-after': '5' }, body: {} };
    });
    const publishable = 'pk_test_RkFLRSQ';

    await expect(authority.verifySettings({
      staging_publishable_key: publishable, staging_secret_key: testKey,
      production_publishable_key: publishable, production_secret_key: testKey,
    }, {}, 1, false)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 5 });

    expect(f.send).toHaveBeenCalledTimes(3);
    expect(wait).not.toHaveBeenCalled();
  });

  it('S3/S4: never retries ambiguous network failures and sends each environment only its key', async() => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error(testKey));
    await expect(f.client.named('create_user', { body: { email_address: ['fake@example.invalid'] } }, f.caller)).rejects.toThrow('Check whether a write succeeded');
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.client.named('get_user', { user_id: 'user_a', environment: 'production' }, f.caller);
    await f.client.named('get_user', { user_id: 'user_a' }, f.caller);
    expect(f.send.mock.calls.map(([, , headers]) => headers.authorization)).toEqual([`Bearer ${ testKey }`, `Bearer ${ liveKey }`, `Bearer ${ testKey }`]);
  });

  const namedWrites = [
    ['create_user', { body: { email_address: ['fake@example.invalid'] } }],
    ['update_user', { user_id: 'user_a', body: { first_name: 'Fake' } }],
    ['update_user_metadata', { user_id: 'user_a', body: { public_metadata: { tier: 'fake' } } }],
    ['create_organization', { body: { name: 'Fake org' } }],
    ['add_membership', { organization_id: 'org_a', body: { user_id: 'user_a', role: 'org:member' } }],
    ['create_invitation', { body: { email_address: 'fake@example.invalid' } }],
    ['create_organization_invitation', { organization_id: 'org_a', body: { email_address: 'fake@example.invalid', role: 'org:member' } }],
  ] as const;
  const serverFailures = [500, 502, 503] as const;

  it.each(serverFailures.flatMap(status => namedWrites.map(([name, input]) => [status, name, input] as const)))(
    'S3: Clerk %i on %s gives the agent one clear retryable error, sends once, and leaks no key', async(status, name, input) => {
      const f = fixture();
      for (const environment of ['staging', 'production'] as const) {
        f.send.mockClear();
        f.wait.mockClear();
        f.send.mockResolvedValue({
          status,
          headers: { 'retry-after': '1', 'x-echo': `Bearer ${ testKey } ${ liveKey }` },
          body:    { errors: [{ code: 'internal_error', message: testKey, long_message: `Bearer ${ liveKey }` }] },
        });
        const worker = new ClerkWorker(() => f.client);
        worker.name = `clerk_${ name }`;
        worker.description = name;
        worker.schemaDef = clerkToolManifests.find(manifest => manifest.name === worker.name)!.schemaDef;
        worker.executionContext = context;
        const saved = toolDecisionPort.resolve();
        toolDecisionPort.register({ request: f.decide, requiresApproval: () => Promise.resolve(false) });
        try {
          const result = await worker.call({ ...input, environment });

          expect(result).toMatchObject({ success: false, status });
          expect(result.result).toBe('Clerk is temporarily unavailable. Check whether a write succeeded before retrying.');
          expect(result).not.toHaveProperty('retryAfter');
          expect(JSON.stringify(result)).not.toMatch(/sk_(?:test|live)_/);
          expect(f.send).toHaveBeenCalledTimes(1);
          expect(f.wait).not.toHaveBeenCalled();
          expect(f.decide).not.toHaveBeenCalled();
        } finally { toolDecisionPort.register(saved) }
      }
    });

  it.each(serverFailures)('S3: the Vault hands a Clerk %i on a raw write back once, without retry hints or key material', async(status) => {
    const f = fixture();
    f.send.mockResolvedValue({ status, headers: { 'retry-after': '1' }, body: { errors: [{ message: testKey }] } });
    await expect(f.client.raw({ method: 'POST', path: '/users', body: { email_address: ['fake@example.invalid'] } }, f.caller))
      .rejects.toMatchObject({ status, message: 'Clerk is temporarily unavailable. Check whether a write succeeded before retrying.' });
    expect(f.send).toHaveBeenCalledTimes(1);

    const response = await f.authority.execute(f.requests[0]);
    expect(response.status).toBe(status);
    expect(response.headers).toEqual({});
    expect(JSON.stringify(response)).not.toContain(testKey);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it('R2: follows next_offset until all users are returned exactly once', async() => {
    const f = fixture();
    const users = Array.from({ length: 103 }, (_, index) => ({ id: `user_${ index }` }));
    f.send.mockImplementation((url) => {
      expect(url.searchParams.get('query')).toBe('al');
      expect(url.searchParams.has('paginated')).toBe(false);
      const from = Number(url.searchParams.get('offset'));
      return Promise.resolve(ok(users.slice(from, from + Number(url.searchParams.get('limit')))));
    });
    const received: unknown[] = [];
    let offset: number | null = 0;
    do {
      const page = await f.client.named('list_users', { filters: { query: 'al', paginated: true }, limit: 50, offset }, f.caller) as { items: unknown[]; next_offset: number | null };
      received.push(...page.items);
      offset = page.next_offset;
    } while (offset !== null);
    expect(received).toEqual(users);
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it('R2: applies the documented user cursor without accidentally combining it with a nonzero offset', async() => {
    const f = fixture();
    const users = Array.from({ length: 5 }, (_, index) => ({ id: `user_${ index }` }));
    f.send.mockImplementation((url) => {
      const after = url.searchParams.get('starting_after');
      const offset = Number(url.searchParams.get('offset'));
      expect(offset).toBe(0);
      const from = after ? users.findIndex(user => user.id === after) + 1 : 0;
      return Promise.resolve(ok(users.slice(from, from + 2)));
    });
    const received: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.client.named('list_users', { limit: 2, starting_after: cursor }, f.caller) as { items: unknown[]; next_cursor: string | null };
      received.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(received).toEqual(users);
    await expect(f.client.named('list_users', { starting_after: 'user_0', offset: 1 }, f.caller)).rejects.toThrow('offset 0');
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it('A4/A6: verifies matching instance domains, trims whitespace, and warns about mislabelled keys', async() => {
    const f = fixture();
    const publishable = `pk_live_${ Buffer.from('clerk.example.invalid$').toString('base64') }`;
    f.send.mockResolvedValueOnce(ok({ id: 'ins_live', environment_type: 'production' }))
      .mockResolvedValueOnce(ok({ data: [{ frontend_api_url: 'https://clerk.example.invalid' }] }));
    const values = await f.authority.verifySettings({ staging_publishable_key: publishable + '\n', staging_secret_key: ' ' + liveKey }, {}, 1, false);
    expect(values).toEqual({
      staging_publishable_key: publishable,
      staging_secret_key:      liveKey,
      staging_instance_id:     'ins_live',
      staging_warning:         expect.stringContaining('production Clerk key'),
    });
    f.send.mockResolvedValueOnce(ok({ id: 'ins_other', environment_type: 'production' }))
      .mockResolvedValueOnce(ok({ data: [{ frontend_api_url: 'https://other.example.invalid' }] }));
    await expect(f.authority.verifySettings({ staging_publishable_key: publishable, staging_secret_key: liveKey }, {}, 1, false)).rejects.toThrow('different Clerk instances');
    f.send.mockResolvedValueOnce({ status: 401, headers: {}, body: { message: liveKey } });
    await expect(f.authority.verifySettings({ production_publishable_key: publishable, production_secret_key: liveKey }, {}, 1, false)).rejects.toThrow('Production: Clerk rejected the secret key (HTTP 401)');
    const calls = f.send.mock.calls.length;
    await expect(f.authority.verifySettings({ staging_publishable_key: publishable, staging_secret_key: 'bad\nkey' }, {}, 1, false)).rejects.toThrow('Staging: the secret key must start with sk_test_ or sk_live_.');
    expect(f.send).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ['', 'sk_test_FAKE', 'Staging: the publishable key is empty.'],
    ['pk_test_PUB', '', 'Staging: the secret key is empty.'],
    ['sk_test_FAKE', 'sk_test_FAKE', 'Staging: the publishable key field contains a secret key'],
    ['GOOD_PK', 'pk_test_PUB', 'Staging: the secret key field contains a publishable key'],
    ['pub_test_x', 'sk_test_FAKE', 'Staging: the publishable key must start with pk_test_ or pk_live_.'],
    ['GOOD_PK', 'sec_test_x', 'Staging: the secret key must start with sk_test_ or sk_live_.'],
    ['GOOD_PK', 'sk_test_FA KE', 'Staging: the secret key contains spaces or line breaks.'],
    ['pk_test_NOTAREALKEY', 'sk_test_FAKE', 'Staging: the publishable key is malformed'],
    ['GOOD_PK', 'sk_test_FA*KE', 'Staging: the secret key is malformed'],
    ['GOOD_PK', 'sk_live_FAKE', 'Staging: the publishable key is pk_test_ but the secret key is sk_live_.'],
  ])('A4: names the field and the problem for publishable %j / secret %j, without calling Clerk', async(publishable, secret, message) => {
    const f = fixture();
    const good = `pk_test_${ Buffer.from('clerk.example.invalid$').toString('base64') }`;
    const attempt = f.authority.verifySettings({ staging_publishable_key: publishable === 'GOOD_PK' ? good : publishable, staging_secret_key: secret }, {}, 1, false);
    await expect(attempt).rejects.toThrow(message);
    await attempt.catch((error: Error) => {
      for (const value of [secret, publishable, good].filter(value => value.length > 8)) expect(error.message).not.toContain(value);
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('A4: tells a rejected key apart from Clerk being unreachable or failing', async() => {
    const f = fixture();
    const publishable = `pk_test_${ Buffer.from('clerk.example.invalid$').toString('base64') }`;
    const input = { staging_publishable_key: publishable, staging_secret_key: 'sk_test_FAKE' };
    f.send.mockResolvedValueOnce({ status: 403, headers: {}, body: {} });
    await expect(f.authority.verifySettings(input, {}, 1, false)).rejects.toThrow('Staging: Clerk rejected the secret key (HTTP 403)');
    f.send.mockResolvedValueOnce({ status: 503, headers: {}, body: {} });
    await expect(f.authority.verifySettings(input, {}, 1, false)).rejects.toThrow('Staging: Clerk could not verify the secret key (HTTP 503)');
    f.send.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(f.authority.verifySettings(input, {}, 1, false)).rejects.toThrow('Staging: Clerk could not be reached');
  });

  it('A4: disconnects only a previously saved Clerk section after an authoritative 401', async() => {
    const f = integrationAccountFixture([{ status: 401, headers: {}, body: { message: 'unauthorized' } }]);
    await expect(f.save()).rejects.toBeInstanceOf(ClerkSavedPairRejectedError);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sealItem).toHaveBeenCalledTimes(1);
    expect(f.updateIntegrationCiphertextIfRevision).toHaveBeenCalledTimes(1);

    const stored = f.savedPlaintext()!;
    const saved = stored.integration.properties as Record<string, string>;
    expect(saved).not.toHaveProperty('staging_secret_key');
    expect(saved).not.toHaveProperty('staging_instance_id');
    expect(saved).not.toHaveProperty('staging_warning');
    expect(saved.staging_publishable_key).toBe(f.properties.staging_publishable_key);
    expect(saved.production_secret_key).toBe(liveKey);
    expect(saved.production_instance_id).toBe('ins_live');
    expect(saved.connection_status).toBe('connected');

    const settings = clerkSettings({
      integrationId: 'clerk', activeAccountId: 'default', accounts: [{
        accountId: 'default', label: 'Clerk', connected: true, credentialRequired: true, active: true,
        revision: f.item.revision, properties: BrokerCredentialFields.safeIntegrationMetadata(saved, 'clerk'),
      }],
    });
    expect(settings.staging.connected).toBe(false);
    expect(settings.production.connected).toBe(true);
  });

  it.each<{ scenario: string; response: BrokerExecuteResponse | Error; values: Record<string, string> }>([
    {
      scenario: 'a rejected different candidate pair',
      response: { status: 401, headers: {}, body: { message: 'unauthorized' } },
      values: { staging_publishable_key: 'pk_test_RkFLRSQ', staging_secret_key: 'sk_test_OTHER_FAKE' },
    },
    {
      scenario: 'a transient network error',
      response: new Error('synthetic network failure'),
      values: { staging_publishable_key: 'pk_test_RkFLRSQ', staging_secret_key: testKey },
    },
    {
      scenario: 'a Clerk 429 response',
      response: { status: 429, headers: { 'retry-after': '30' }, body: {} },
      values: { staging_publishable_key: 'pk_test_RkFLRSQ', staging_secret_key: testKey },
    },
    {
      scenario: 'a Clerk 5xx response',
      response: { status: 503, headers: {}, body: {} },
      values: { staging_publishable_key: 'pk_test_RkFLRSQ', staging_secret_key: testKey },
    },
  ])('A4: preserves current Clerk data after $scenario', async({ response, values }) => {
    const f = integrationAccountFixture([response]);
    await expect(f.save(values)).rejects.toThrow();
    expect(f.sealItem).not.toHaveBeenCalled();
    expect(f.updateIntegrationCiphertextIfRevision).not.toHaveBeenCalled();
    expect(f.item.ciphertext).toBe('existing-ciphertext');
    expect(f.properties.staging_secret_key).toBe(testKey);
    expect(f.properties.production_secret_key).toBe(liveKey);
  });

  it('aborts at final target resolution before sending to Clerk', async() => {
    const f = fixture();
    const abort = new AbortController();
    f.validateTarget.mockImplementationOnce((input) => {
      abort.abort();
      return Promise.resolve(new URL(input));
    });
    await expect(f.client.raw({ path: '/users' }, { ...f.caller, signal: abort.signal })).rejects.toThrow('cancelled');
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe('Desktop relay dispatch', () => {
  it('forwards an ordinary tool but refuses a registered Clerk tool before loading it', async() => {
    // Exercise the configured Desktop callback without a socket or an actual integration.
    const load = vi.fn(async() => ({ invoke: async() => ({ success: true, result: 'pong' }) }));
    toolRegistry.register('meta_fixture_ping', '', 'meta', load);
    toolRegistry.register('clerk_fixture_ping', '', 'clerk', load);
    vi.stubEnv('SULLA_RELAY_URL', 'http://relay.invalid');
    vi.stubEnv('SULLA_RELAY_DEVICE_TOKEN', 'fixture');
    const start = vi.spyOn(RelayToolTunnel.prototype, 'start').mockImplementation(() => {});
    try {
      const execute = startRelayToolTunnel()!['options'].execute;
      const signal = new AbortController().signal;
      expect(await execute(context, 'meta', 'fixture_ping', {}, signal)).toEqual({ success: true, result: 'pong' });
      expect(await execute(context, 'clerk', 'fixture_ping', {}, signal)).toMatchObject({
        success: false, error: { code: 'clerk_relay_forbidden' },
      });
      expect(load).toHaveBeenCalledTimes(1);
    } finally { stopRelayToolTunnel(); start.mockRestore(); vi.unstubAllEnvs(); }
  });
});
