// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ containerRequest: vi.fn() }));

vi.mock('../../../files/containerClient', () => ({ filesContainerRequest: harness.containerRequest }));
// The tool receives its real collaborators explicitly; keep the unrelated
// process-wide composition root from starting another approval subscriber.
vi.mock('../../../tools/toolRuntime', () => ({ toolRuntime: {
  publishApprovalCoordinator: { start: vi.fn() },
  publishApprovalRouter: { requester: vi.fn(), cardTarget: vi.fn() },
} }));
vi.mock('../../../services/DecisionService', async(importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/DecisionService')>();
  return { ...actual, decisionService: {} };
});

import { DecisionService } from '../../../services/DecisionService';
import { FilesRequestPublishWorker } from '../../../tools/files/request_publish';
import { PublishApprovalCoordinator } from '../../../tools/files/PublishApprovalCoordinator';
import { PublishApprovalOutcomeMessage } from '../../../tools/files/PublishApprovalOutcomeMessage';
import { PublishApprovalRouter } from '../../../tools/files/PublishApprovalRouter';
import { filesToolManifests } from '../../../tools/files/manifests';
import { toolDecisionPort, UnavailableToolDecisionPort } from '../../../tools/toolDecisionPort';

const manifest = filesToolManifests.find(entry => entry.name === 'files_request_publish')!;
const draft = { file: { path: 'Use Cases/skills/example/SKILL.md' }, content_base64: '' };

function response(body: unknown) {
  return { status: 200, json: async() => body } as Response;
}

class InMemoryDecisionServiceFixture {
  readonly records = new Map<string, any>();
  readonly repository = {
    insert: vi.fn(async(record: any) => { this.records.set(record.id, record) }),
    settle: vi.fn(async(id: string, _action: string, next: any) => {
      if (!this.records.has(id)) return false;
      this.records.set(id, next);
      return true;
    }),
    expirePending: vi.fn(async(id: string) => this.records.get(id)),
  };
  readonly pendingRepository = {
    ancestry: vi.fn(async() => []),
    findApproval: vi.fn(async(_session: string, key: string, value: string) => [...this.records.values()].find(record => record.kind === 'approval' && record.payload?.[key] === value)),
  };
  readonly service = new DecisionService(undefined, {
    decisions: this.repository as any,
    pendingDecisions: this.pendingRepository as any,
    parentFyiNotifier: { notify: async() => undefined } as any,
  });
}

const activeWorkers: Array<{ decisions:InMemoryDecisionServiceFixture; coordinator:PublishApprovalCoordinator }> = [];

function worker() {
  const decisions = new InMemoryDecisionServiceFixture();
  const router = new PublishApprovalRouter({ taskForThread: async() => null });
  const coordinator = new PublishApprovalCoordinator(decisions.service, { deliver: async() => true }, new PublishApprovalOutcomeMessage({ name: async() => 'Jonathon' }));
  const rootChat = { send: vi.fn(async() => true) };
  const instance = new FilesRequestPublishWorker(coordinator, decisions.service, router, rootChat);
  instance.schemaDef = manifest.schemaDef;
  instance.name = manifest.name;
  instance.metadata.category = 'files';
  instance.metadata.operationTypes = ['update'];
  instance.sendChatMessage = vi.fn(async() => true);
  const state = { metadata: { threadId: 'thread-1', wsChannel: 'sulla-desktop' } } as any;
  activeWorkers.push({ decisions, coordinator });
  return { instance, state, decisions, invoke: (input: unknown) => instance.invoke(input, state) };
}

describe('files_request_publish clear results', () => {
  beforeEach(() => {
    toolDecisionPort.register({ requiresApproval: async() => false, request: async() => { throw new Error('not expected in this test') } });
    harness.containerRequest.mockReset();
    harness.containerRequest.mockImplementation(async(path: string, _context: unknown, init?: RequestInit) => {
      if (path.startsWith('/v1/agent-files/')) return response(draft);
      if (path.endsWith('/publish-request') && init?.method === 'POST') return response({ id: 'publish-request-1' });
      throw new Error(`Unexpected Files endpoint: ${ path }`);
    });
  });

  afterEach(async() => {
    for (const { decisions, coordinator } of activeWorkers.splice(0)) {
      for (const record of decisions.records.values()) {
        await decisions.service.resolve({ id: record.id, conversationId: record.conversationId, action: 'approved' }, { kind: 'human' });
      }
      coordinator.dispose();
    }
    toolDecisionPort.register(new UnavailableToolDecisionPort());
  });

  it('returns the Files request id after the real approval-routing path succeeds', async() => {
    // risk: irreversible side effects — callers must receive the durable Files request id they need to track human publication approval.
    const call = worker();
    const result = await call.invoke({ file_id: 'file-1', version_id: 'version-1' });

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.result as string);
    expect(payload).toMatchObject({ request_id: 'publish-request-1', status: 'pending' });
    expect(call.decisions.records.has(payload.decision_id)).toBe(true);
    expect(harness.containerRequest).toHaveBeenCalledWith(
      '/v1/files/file-1/versions/version-1/publish-request', expect.anything(),
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(call.instance.sendChatMessage).toHaveBeenCalledWith('', 'tool_approval', expect.objectContaining({ toolApproval: expect.objectContaining({ approvalId: payload.decision_id }) }));
  });

  it('returns the same clear availability error for a Files transport timeout', async() => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    harness.containerRequest.mockRejectedValueOnce(timeout);
    const result = await worker().invoke({ file_id: 'file-1', version_id: 'version-1' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Sulla Files is unreachable right now. Please try again in a moment.');
  });

  it('passes a Files transport recovery message through unchanged', async() => {
    const message = 'Sulla Files transport is unavailable; reconnecting the local service.';
    harness.containerRequest.mockRejectedValueOnce(new Error(message));
    const result = await worker().invoke({ file_id: 'file-1', version_id: 'version-1' });
    expect(result.success).toBe(false);
    expect(result.error).toBe(message);
  });

  it('rejects missing identifiers before reaching the Files service', async() => {
    const result = await worker().invoke({ file_id: '', version_id: 'version-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file_id and version_id are required/);
    expect(harness.containerRequest).not.toHaveBeenCalled();
  });

  it('returns missing-field schema validation as a tool result instead of leaking a rejected call', async() => {
    const result = await worker().invoke({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing required field: file_id/);
    expect(result.error).toMatch(/Missing required field: version_id/);
    expect(harness.containerRequest).not.toHaveBeenCalled();
  });
});
